import { existsSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import ts from 'typescript'

/**
 * 服务端架构边界棘轮（ADR 0034）：
 * 1. 锁死存量跨层反向依赖与运行时循环依赖边白名单——只许减少、禁止新增。
 * 2. 边界与模块封装校验覆盖值导入与类型导入（import/export type）；循环依赖校验仅看运行时图。
 * 3. 对新建的模块化单体目录（modules/<bc>/、delivery/http/）从第一天起执行零容忍硬规则。
 * 4. 保证 packages/db/src（含聚合入口 schema.ts 与全部 schemas/*）保持无环 DAG。
 */

const tsTranspiler = new Bun.Transpiler({ loader: 'ts' })
const tsxTranspiler = new Bun.Transpiler({ loader: 'tsx' })
const sourceGlob = new Bun.Glob('**/*.{ts,tsx}')

const ALLOWED_ROUTE_TO_DB = new Set<string>([])

const ALLOWED_DB_TO_OUTSIDE = new Set([
  'db/client.ts -> config.ts',
  'db/maintenance.ts -> config.ts',
  'db/maintenance.ts -> lib/agent/batch-progress.ts',
  'db/maintenance.ts -> lib/agent/conversations.ts',
  'db/maintenance.ts -> lib/durableMediaStore.ts',
  'db/maintenance.ts -> lib/logger.ts',
  'db/maintenance.ts -> lib/objectStore.ts',
  'db/maintenance.ts -> lib/retry.ts',
  'db/maintenance.ts -> lib/sync-assets.ts',
  'db/maintenance.ts -> modules/execution/index.ts',
  'db/migrate.ts -> config.ts',
  'db/migrate.ts -> lib/capabilities.ts',
  'db/migrate.ts -> lib/private-overlay.ts',
])

const ALLOWED_EXECUTION_TO_LEGACY_LIB = new Set([
  'modules/execution/submission-admission.ts -> lib/billing-ports.ts',
  'modules/execution/submission-admission.ts -> lib/capabilities.ts',
  'modules/execution/submission-admission.ts -> lib/metering-decision.ts',
  'modules/execution/submission-admission.ts -> lib/model-availability.ts',
  'modules/execution/submission-admission.ts -> lib/quota.ts',
  'modules/execution/submission-idempotency.ts -> lib/canonicalJson.ts',
  'modules/execution/submission-idempotency.ts -> lib/capabilities.ts',
  'modules/execution/submission-idempotency.ts -> lib/channels.ts',
  'modules/execution/submission-idempotency.ts -> lib/imageArchive.ts',
  'modules/execution/submission-idempotency.ts -> lib/queueProvider.ts',
  'modules/execution/submission-prepare.ts -> lib/channels.ts',
  'modules/execution/submission-prepare.ts -> lib/imageArchive.ts',
  'modules/execution/submission-prepare.ts -> lib/objectStore.ts',
  'modules/execution/submission-tier.ts -> lib/billing-ports.ts',
  'modules/execution/submission-tier.ts -> lib/channels.ts',
  'modules/execution/submission-tier.ts -> lib/gpt-membership.ts',
  'modules/execution/submission-tier.ts -> lib/type-guards.ts',
  'modules/execution/submission-tier.ts -> lib/upstream/gpt-routing.ts',
  'modules/execution/task-outcome.ts -> lib/extractImages.ts',
  'modules/execution/task-outcome.ts -> lib/public-task-error.ts',
  'modules/execution/task-outcome.ts -> lib/queueProvider.ts',
  'modules/execution/task-submission-plugins.ts -> lib/quota.ts',
  'modules/execution/task-submission.ts -> lib/capabilities.ts',
  'modules/execution/task-submission.ts -> lib/telemetry.ts',
  'modules/execution/task-submission.ts -> lib/upstream/gpt-direct-availability.ts',
])

/**
 * 存量运行时强连通分量内的具体有向边白名单（边级棘轮）：
 * 删边使分量缩小时自然通过；在原分量节点集合内新增任何成环边都会立即拦截。
 */
const ALLOWED_RUNTIME_CYCLE_EDGES = new Set([
  'lib/agent/batch-analysis-preparation.ts -> lib/agent/batch-plans.ts',
  'lib/agent/batch-execution.ts -> lib/agent/batch-plans.ts',
  'lib/agent/batch-phase-edit.ts -> lib/agent/batch-analysis-preparation.ts',
  'lib/agent/batch-phase-edit.ts -> lib/agent/batch-execution.ts',
  'lib/agent/batch-phase-edit.ts -> lib/agent/batch-plan-revision.ts',
  'lib/agent/batch-phase-edit.ts -> lib/agent/batch-plans.ts',
  'lib/agent/batch-plan-revision.ts -> lib/agent/batch-plans.ts',
  'lib/agent/batch-plans.ts -> lib/agent/batch-analysis-preparation.ts',
  'lib/agent/batch-plans.ts -> lib/agent/batch-phase-edit.ts',
])

const CORE_PLATFORM_MODULES = new Set(['identity', 'catalog', 'media', 'execution'])
const UPPER_APP_MODULES = new Set(['agent', 'canvas', 'library', 'cms'])

const AGENT_LAYER_RANK: Readonly<Record<string, number>> = {
  contracts: 0,
  conversation: 1,
  inbox: 2,
  runtime: 3,
  tools: 4,
  orchestration: 5,
}

const JS_EXTENSION_PATTERN = /\.(?:[cm]?js|jsx)$/

function resolveInternalTarget(
  normalizedRoot: string,
  fromFile: string,
  specifier: string,
): string | null {
  if (!specifier.startsWith('.')) return null
  const baseDir = dirname(resolve(normalizedRoot, fromFile))
  const stem = JS_EXTENSION_PATTERN.test(specifier)
    ? specifier.replace(JS_EXTENSION_PATTERN, '')
    : null
  const candidates = [
    resolve(baseDir, `${specifier}.ts`),
    resolve(baseDir, `${specifier}.tsx`),
    resolve(baseDir, specifier, 'index.ts'),
    resolve(baseDir, specifier, 'index.tsx'),
    resolve(baseDir, specifier),
    ...(stem ? [resolve(baseDir, `${stem}.ts`), resolve(baseDir, `${stem}.tsx`)] : []),
  ]
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    if (!candidate.endsWith('.ts') && !candidate.endsWith('.tsx')) continue
    const rel = relative(normalizedRoot, candidate).replaceAll('\\', '/')
    if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) continue
    if (rel.includes('__tests__')) return null
    return rel
  }
  return null
}

function scanAllSpecifiers(file: string, text: string): string[] {
  const sourceFile = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    false,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const specifiers = new Set<string>()

  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.add(node.moduleSpecifier.text)
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]!) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      specifiers.add(node.arguments[0]!.text)
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      specifiers.add(node.moduleReference.expression.text)
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      specifiers.add(node.argument.literal.text)
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return [...specifiers]
}

interface ImportGraphs {
  files: string[]
  /** 仅运行时依赖（忽略纯类型导入），用于检测运行时循环依赖。 */
  runtimeAdjacency: Map<string, string[]>
  /** 完整依赖（含 import/export type 与动态导入），用于边界与封装门禁。 */
  allAdjacency: Map<string, string[]>
}

async function buildImportGraphs(rootDir: string): Promise<ImportGraphs> {
  const normalizedRoot = resolve(rootDir)
  const files: string[] = []
  if (!existsSync(normalizedRoot)) {
    return { files, runtimeAdjacency: new Map(), allAdjacency: new Map() }
  }

  for await (const file of sourceGlob.scan({ cwd: normalizedRoot, onlyFiles: true })) {
    const normalized = file.replaceAll('\\', '/')
    if (normalized.includes('__tests__')) continue
    files.push(normalized)
  }
  files.sort()

  const runtimeAdjacency = new Map<string, string[]>()
  const allAdjacency = new Map<string, string[]>()
  for (const file of files) {
    const text = await Bun.file(resolve(normalizedRoot, file)).text()
    const transpiler = file.endsWith('.tsx') ? tsxTranspiler : tsTranspiler
    const runtimeTargets = new Set<string>()
    for (const imp of transpiler.scanImports(text)) {
      if (
        imp.kind !== 'import-statement' &&
        imp.kind !== 'dynamic-import' &&
        imp.kind !== 'require-call'
      ) {
        continue
      }
      const target = resolveInternalTarget(normalizedRoot, file, imp.path)
      if (target && target !== file) runtimeTargets.add(target)
    }
    const allTargets = new Set<string>(runtimeTargets)
    for (const specifier of scanAllSpecifiers(file, text)) {
      const target = resolveInternalTarget(normalizedRoot, file, specifier)
      if (target && target !== file) allTargets.add(target)
    }
    runtimeAdjacency.set(file, [...runtimeTargets].sort())
    allAdjacency.set(file, [...allTargets].sort())
  }
  return { files, runtimeAdjacency, allAdjacency }
}

export function findStronglyConnectedCycles(
  files: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
): string[][] {
  let nextIndex = 0
  const nodeIndex = new Map<string, number>()
  const lowLink = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const cycles: string[][] = []

  function strongConnect(node: string): void {
    nodeIndex.set(node, nextIndex)
    lowLink.set(node, nextIndex)
    nextIndex++
    stack.push(node)
    onStack.add(node)

    for (const neighbor of adjacency.get(node) ?? []) {
      if (!nodeIndex.has(neighbor)) {
        strongConnect(neighbor)
        lowLink.set(node, Math.min(lowLink.get(node)!, lowLink.get(neighbor)!))
      } else if (onStack.has(neighbor)) {
        lowLink.set(node, Math.min(lowLink.get(node)!, nodeIndex.get(neighbor)!))
      }
    }

    if (lowLink.get(node) === nodeIndex.get(node)) {
      const component: string[] = []
      while (true) {
        const member = stack.pop()!
        onStack.delete(member)
        component.push(member)
        if (member === node) break
      }
      if (component.length > 1) cycles.push(component.sort())
    }
  }

  for (const file of files) {
    if (!nodeIndex.has(file)) strongConnect(file)
  }
  return cycles
}

function moduleOf(path: string): { name: string; rest: string } | null {
  const match = /^modules\/([^/]+)\/(.+)$/.exec(path)
  return match ? { name: match[1]!, rest: match[2]! } : null
}

function agentLayerOf(rest: string): string | null {
  const match = /^([^/]+)\//.exec(rest)
  if (!match) return null
  return match[1]! in AGENT_LAYER_RANK ? match[1]! : null
}

export async function checkBffBoundaries(bffRoot: string): Promise<string[]> {
  const { files, runtimeAdjacency, allAdjacency } = await buildImportGraphs(bffRoot)
  const violations: string[] = []

  for (const file of files) {
    const fromModule = moduleOf(file)

    for (const target of allAdjacency.get(file) ?? []) {
      const edge = `${file} -> ${target}`
      const toModule = moduleOf(target)

      if (
        (file.startsWith('routes/') || file.startsWith('delivery/http/')) &&
        target.startsWith('db/')
      ) {
        if (!ALLOWED_ROUTE_TO_DB.has(edge)) {
          violations.push(
            `[routes -> db] ${edge} is not allowed (move query/mutation into a module service or read-model)`,
          )
        }
      }

      if (file.startsWith('db/') && !target.startsWith('db/')) {
        if (!ALLOWED_DB_TO_OUTSIDE.has(edge)) {
          violations.push(`[db -> non-db] ${edge} is not allowed (keep db/ free of upward deps)`)
        }
      }

      if (
        (file.startsWith('workers/') || file.startsWith('delivery/workers/')) &&
        (target.startsWith('lib/agent/') || target.startsWith('modules/agent/'))
      ) {
        violations.push(
          `[workers -> agent] ${edge} is not allowed (keep queue workers decoupled from agent)`,
        )
      }

      if (toModule && fromModule?.name !== toModule.name && !file.startsWith('bootstrap/')) {
        if (toModule.rest !== 'index.ts') {
          violations.push(
            `[module-encapsulation] ${edge} bypasses modules/${toModule.name}/index.ts facade`,
          )
        }
      }

      if (
        fromModule &&
        toModule &&
        fromModule.name !== toModule.name &&
        CORE_PLATFORM_MODULES.has(fromModule.name) &&
        UPPER_APP_MODULES.has(toModule.name)
      ) {
        violations.push(
          `[core -> app-module] ${edge} violates ADR 0034 DAG (core platform must not depend on upper modules)`,
        )
      }

      if (
        fromModule &&
        CORE_PLATFORM_MODULES.has(fromModule.name) &&
        target.startsWith('lib/agent/')
      ) {
        violations.push(
          `[core -> legacy-agent] ${edge} violates ADR 0034 DAG (core platform must not depend on lib/agent)`,
        )
      } else if (
        fromModule?.name === 'execution' &&
        target.startsWith('lib/') &&
        !ALLOWED_EXECUTION_TO_LEGACY_LIB.has(edge)
      ) {
        violations.push(
          `[execution -> legacy-lib] ${edge} is not allowed (invert upward/legacy dependency via TaskLifecycleBus or port)`,
        )
      }

      if (fromModule?.name === 'agent' && toModule?.name === 'agent') {
        const fromLayer = agentLayerOf(fromModule.rest)
        const toLayer = agentLayerOf(toModule.rest)
        if (fromLayer && toLayer && AGENT_LAYER_RANK[fromLayer]! < AGENT_LAYER_RANK[toLayer]!) {
          violations.push(
            `[agent-layer] ${edge} violates ADR 0034 agent sub-layer order (${fromLayer} -> ${toLayer})`,
          )
        }
      }
    }
  }

  for (const cycle of findStronglyConnectedCycles(files, runtimeAdjacency)) {
    const members = new Set(cycle)
    const cycleLabel = cycle.join(' <-> ')
    for (const node of cycle) {
      for (const target of runtimeAdjacency.get(node) ?? []) {
        if (!members.has(target)) continue
        const edge = `${node} -> ${target}`
        if (!ALLOWED_RUNTIME_CYCLE_EDGES.has(edge)) {
          violations.push(`[import-cycle] new runtime cycle edge: ${edge} (in ${cycleLabel})`)
        }
      }
    }
  }

  return violations
}

export async function checkDirAcyclic(rootDir: string, label: string): Promise<string[]> {
  const { files, runtimeAdjacency } = await buildImportGraphs(rootDir)
  return findStronglyConnectedCycles(files, runtimeAdjacency).map(
    (cycle) => `[import-cycle] runtime cycle in ${label}: ${cycle.join(' <-> ')}`,
  )
}

if (import.meta.main) {
  const repoRoot = resolve(import.meta.dir, '..')
  const [bffViolations, dbViolations] = await Promise.all([
    checkBffBoundaries(resolve(repoRoot, 'apps/bff/src')),
    checkDirAcyclic(resolve(repoRoot, 'packages/db/src'), 'packages/db/src'),
  ])
  const allViolations = [...bffViolations, ...dbViolations]
  if (allViolations.length > 0) {
    console.error(
      `Architecture boundary violations (${allViolations.length}):\n${allViolations.join('\n')}`,
    )
    process.exit(1)
  }
}
