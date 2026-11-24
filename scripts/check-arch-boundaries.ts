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
  'db/maintenance.ts -> lib/durableMediaStore.ts',
  'db/maintenance.ts -> lib/logger.ts',
  'db/maintenance.ts -> lib/objectStore.ts',
  'db/maintenance.ts -> lib/retry.ts',
  'db/maintenance.ts -> lib/sync-assets.ts',
  'db/maintenance.ts -> modules/agent/index.ts',
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

/**
 * `lib/agent/* -> lib/agent/tools/*` 反向依赖已于 PR-4.4 彻底归零（原 46 -> 5 -> 0）；
 * 任何 `lib/agent/*`（非 `lib/agent/tools/*` 兼容壳）均禁止再引入 `lib/agent/tools/*`。
 */
const ALLOWED_AGENT_CORE_TO_TOOLS = new Set<string>([])

/**
 * 存量 `lib/agent/* -> modules/agent/tools/*` 边棘轮（PR-4.4）：
 * 将原 5 处 `lib/agent/* -> lib/agent/tools/index.ts` 迁至 `modules/agent/tools/index.ts` 后，
 * 继续锁死仅此 5 个编排入口可依赖工具层，防止其余 `lib/agent/*` 文件新增对工具层的耦合。
 */
const ALLOWED_LEGACY_AGENT_TO_MODULE_TOOLS = new Set([
  'lib/agent/interrupted.ts -> modules/agent/tools/index.ts',
  'lib/agent/model-history.ts -> modules/agent/tools/index.ts',
  'lib/agent/turn-input.ts -> modules/agent/tools/index.ts',
  'lib/agent/turn-preparation.ts -> modules/agent/tools/index.ts',
  'lib/agent/turn.ts -> modules/agent/tools/index.ts',
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

/** 已迁入 `modules/agent/{contracts,conversation,inbox,runtime}` 的旧 `lib/agent/*` 兼容壳，工具层禁止回流依赖。 */
const LEGACY_AGENT_MIGRATED_SHIMS = new Set([
  'lib/agent/background-jobs.ts',
  'lib/agent/background-work.ts',
  'lib/agent/compaction-transform.ts',
  'lib/agent/conversation-images.ts',
  'lib/agent/conversation-state.ts',
  'lib/agent/conversations.ts',
  'lib/agent/events.ts',
  'lib/agent/execution.ts',
  'lib/agent/images.ts',
  'lib/agent/inbox-pickup.ts',
  'lib/agent/inbox.ts',
  'lib/agent/job-artifacts.ts',
  'lib/agent/lifecycle.ts',
  'lib/agent/modelImage.ts',
  'lib/agent/review-images.ts',
  'lib/agent/runningTurns.ts',
  'lib/agent/selection-preview.ts',
  'lib/agent/selection-settings.ts',
  'lib/agent/sse.ts',
  'lib/agent/tool-gate-records.ts',
  'lib/agent/turn-failure.ts',
  'lib/agent/turn-summary.ts',
  'lib/agent/turn.ts',
  'lib/agent/visual-input.ts',
  'lib/agent/visual-resources.ts',
  'lib/agent/visual-workset.ts',
  'lib/agent/wake-prompt.ts',
  'lib/agent/wake.ts',
])

/** ADR 0034 Phase 4 PR-4.3：`modules/agent/runtime/` 单文件扇出硬上限（严格 < 12）。 */
const MAX_AGENT_RUNTIME_FAN_OUT = 11

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
      node.arguments.length >= 1 &&
      ts.isStringLiteralLike(node.arguments[0]!) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === 'require' &&
          node.arguments.length === 1))
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
  /** 每个源文件去重后的总导入模块数（含外部包与本地模块），用于单文件扇出门禁。 */
  specifierCounts: Map<string, number>
}

async function buildImportGraphs(rootDir: string): Promise<ImportGraphs> {
  const normalizedRoot = resolve(rootDir)
  const files: string[] = []
  if (!existsSync(normalizedRoot)) {
    return {
      files,
      runtimeAdjacency: new Map(),
      allAdjacency: new Map(),
      specifierCounts: new Map(),
    }
  }

  for await (const file of sourceGlob.scan({ cwd: normalizedRoot, onlyFiles: true })) {
    const normalized = file.replaceAll('\\', '/')
    if (normalized.includes('__tests__')) continue
    files.push(normalized)
  }
  files.sort()

  const runtimeAdjacency = new Map<string, string[]>()
  const allAdjacency = new Map<string, string[]>()
  const specifierCounts = new Map<string, number>()
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
    const allSpecifiers = scanAllSpecifiers(file, text)
    const allTargets = new Set<string>(runtimeTargets)
    for (const specifier of allSpecifiers) {
      const target = resolveInternalTarget(normalizedRoot, file, specifier)
      if (target && target !== file) allTargets.add(target)
    }
    runtimeAdjacency.set(file, [...runtimeTargets].sort())
    allAdjacency.set(file, [...allTargets].sort())
    specifierCounts.set(file, allSpecifiers.length)
  }
  return { files, runtimeAdjacency, allAdjacency, specifierCounts }
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

function agentToolDomainOf(rest: string): string | null {
  const match = /^tools\/([^/]+)\//.exec(rest)
  return match ? match[1]! : null
}

export async function checkBffBoundaries(bffRoot: string): Promise<string[]> {
  const { files, runtimeAdjacency, allAdjacency, specifierCounts } =
    await buildImportGraphs(bffRoot)
  const violations: string[] = []

  for (const file of files) {
    const fromModule = moduleOf(file)
    if (
      fromModule?.name === 'agent' &&
      agentLayerOf(fromModule.rest) === 'runtime' &&
      fromModule.rest !== 'runtime/index.ts'
    ) {
      const fanOut = specifierCounts.get(file) ?? 0
      if (fanOut > MAX_AGENT_RUNTIME_FAN_OUT) {
        violations.push(
          `[agent-runtime-fanout] ${file} imports ${fanOut} modules (max ${MAX_AGENT_RUNTIME_FAN_OUT})`,
        )
      }
    }

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
        if (
          toModule.rest !== 'index.ts' &&
          !(
            toModule.name === 'agent' &&
            (toModule.rest === 'contracts/index.ts' || toModule.rest === 'tools/index.ts')
          )
        ) {
          violations.push(
            `[module-encapsulation] ${edge} bypasses modules/${toModule.name}/index.ts facade`,
          )
        }
      }

      if (
        fromModule?.name === 'canvas' &&
        (toModule?.name === 'agent' || target.startsWith('lib/agent/'))
      ) {
        violations.push(
          `[canvas -> agent] ${edge} is not allowed (modules/canvas must stay decoupled from agent)`,
        )
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
        if (fromLayer && toModule.rest === 'index.ts') {
          violations.push(
            `[agent-layer] ${edge} violates ADR 0034 agent sub-layer order (${fromLayer} -> facade index.ts)`,
          )
        } else if (
          fromLayer &&
          toLayer &&
          AGENT_LAYER_RANK[fromLayer]! < AGENT_LAYER_RANK[toLayer]!
        ) {
          violations.push(
            `[agent-layer] ${edge} violates ADR 0034 agent sub-layer order (${fromLayer} -> ${toLayer})`,
          )
        } else if (fromLayer === 'tools' && (toLayer === 'runtime' || toLayer === 'inbox')) {
          violations.push(
            `[agent-tools -> ${toLayer}] ${edge} is not allowed (tools must not depend on ${toLayer})`,
          )
        }
        const fromToolDomain = agentToolDomainOf(fromModule.rest)
        const toToolDomain = agentToolDomainOf(toModule.rest)
        if (fromToolDomain && toToolDomain && fromToolDomain !== toToolDomain) {
          violations.push(
            `[agent-tools -> inter-tool] ${edge} is not allowed (tools in ${fromToolDomain}/ must not import tools in ${toToolDomain}/)`,
          )
        } else if (
          fromToolDomain &&
          (toModule.rest === 'tools/index.ts' || toModule.rest === 'tools/registry.ts')
        ) {
          violations.push(
            `[agent-tools -> registry] ${edge} is not allowed (domain tools must not import tools facade or registry)`,
          )
        } else if (
          fromModule.rest === 'tools/adapter.ts' &&
          (toToolDomain !== null ||
            toModule.rest === 'tools/index.ts' ||
            toModule.rest === 'tools/registry.ts')
        ) {
          violations.push(
            `[agent-tools -> adapter-upward] ${edge} is not allowed (tools/adapter.ts must stay below domain tools and registry)`,
          )
        }
      }

      if (fromModule?.name === 'agent' && target.startsWith('lib/agent/')) {
        const layer = agentLayerOf(fromModule.rest)
        if (layer === 'contracts' || layer === 'conversation' || layer === 'inbox') {
          violations.push(
            `[agent-${layer} -> legacy-agent] ${edge} is not allowed (${layer} layer must stay free of lib/agent deps)`,
          )
        } else if (layer === 'runtime' && target.startsWith('lib/agent/tools/')) {
          violations.push(
            `[agent-runtime -> legacy-tools] ${edge} is not allowed (inject tool capabilities via TurnRuntimePorts instead)`,
          )
        } else if (layer === 'tools' && target.startsWith('lib/agent/tools/')) {
          violations.push(
            `[agent-tools -> legacy-tools] ${edge} is not allowed (use modules/agent/tools internal modules directly)`,
          )
        } else if (layer === 'tools' && LEGACY_AGENT_MIGRATED_SHIMS.has(target)) {
          violations.push(
            `[agent-tools -> legacy-agent-layer] ${edge} is not allowed (import from modules/agent/contracts or modules/agent/conversation instead)`,
          )
        }
      }

      if (
        file.startsWith('lib/agent/') &&
        !file.startsWith('lib/agent/tools/') &&
        target.startsWith('lib/agent/tools/') &&
        !ALLOWED_AGENT_CORE_TO_TOOLS.has(edge)
      ) {
        violations.push(
          `[agent-core -> tools] ${edge} is not allowed (import shared contracts from modules/agent instead)`,
        )
      }

      if (
        file.startsWith('lib/agent/') &&
        !file.startsWith('lib/agent/tools/') &&
        target.startsWith('modules/agent/tools/') &&
        !ALLOWED_LEGACY_AGENT_TO_MODULE_TOOLS.has(edge)
      ) {
        violations.push(
          `[agent-core -> module-tools] ${edge} is not allowed (keep legacy lib/agent core decoupled from modules/agent/tools)`,
        )
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

  for (const file of files) {
    const fromModule = moduleOf(file)
    if (fromModule?.name !== 'agent' || agentLayerOf(fromModule.rest) !== 'contracts') continue
    const visited = new Set<string>([file])
    const queue: Array<{ node: string; via: string }> = []
    for (const next of runtimeAdjacency.get(file) ?? []) {
      if (visited.has(next)) continue
      visited.add(next)
      queue.push({ node: next, via: next })
    }
    while (queue.length > 0) {
      const current = queue.shift()!
      if (current.node === 'config.ts' || current.node.startsWith('db/')) {
        const suffix = current.via === current.node ? '' : ` (via ${current.via})`
        violations.push(
          `[agent-contracts -> runtime-env] ${file} -> ${current.node}${suffix} is not allowed (contracts must stay import-safe without DATABASE_URL / config / db)`,
        )
        continue
      }
      for (const next of runtimeAdjacency.get(current.node) ?? []) {
        if (visited.has(next)) continue
        visited.add(next)
        queue.push({ node: next, via: current.via })
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

/**
 * 共享只读模型包护栏（ADR 0034 Phase 3 PR-3.3）：
 * 1. `packages/read-models/src` 内部保持无环 DAG；
 * 2. 禁止在包内导入 `bun`/`bun:*`/`postgres` 或通过静态/动态/命名空间/重导出方式获取 `createDb`
 *    （只接受调用方注入句柄，确保 Admin 只读角色校验不被绕过）；
 * 3. `types.ts` 保持纯类型与浏览器安全，仅允许导入 `@image-playground/shared`（含子路径）。
 */
export async function checkReadModelsBoundaries(rootDir: string): Promise<string[]> {
  const violations = await checkDirAcyclic(rootDir, 'packages/read-models/src')
  const normalizedRoot = resolve(rootDir)
  if (!existsSync(normalizedRoot)) return violations

  const isDbPackage = (spec: string) =>
    spec === '@image-playground/db' || spec.startsWith('@image-playground/db/')
  const isForbiddenDriver = (spec: string) =>
    spec === 'bun' || spec.startsWith('bun:') || spec === 'postgres' || spec.startsWith('postgres/')
  const isAllowedTypesImport = (spec: string) =>
    spec === '@image-playground/shared' || spec.startsWith('@image-playground/shared/')

  for await (const file of sourceGlob.scan({ cwd: normalizedRoot, onlyFiles: true })) {
    const normalized = file.replaceAll('\\', '/')
    if (normalized.includes('__tests__')) continue
    const text = await Bun.file(resolve(normalizedRoot, normalized)).text()
    const specifiers = scanAllSpecifiers(normalized, text)
    for (const spec of specifiers) {
      if (isForbiddenDriver(spec)) {
        violations.push(
          `[read-models-pool] packages/read-models/src/${normalized} must not import ${spec} (inject DbHandle instead of creating SQL pools)`,
        )
      }
      if (normalized === 'types.ts' && !isAllowedTypesImport(spec)) {
        violations.push(
          `[read-models-types] packages/read-models/src/types.ts must not import ${spec} (only @image-playground/shared is allowed to keep browser-safe)`,
        )
      }
    }
    const sourceFile = ts.createSourceFile(normalized, text, ts.ScriptTarget.Latest, false)
    let forbiddenDbPoolReason: string | null = null
    const visit = (node: ts.Node): void => {
      if (forbiddenDbPoolReason) return
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        isDbPackage(node.moduleSpecifier.text)
      ) {
        const bindings = node.importClause?.namedBindings
        if (bindings && ts.isNamespaceImport(bindings)) {
          forbiddenDbPoolReason = 'namespace import from @image-playground/db'
        } else if (bindings && ts.isNamedImports(bindings)) {
          for (const el of bindings.elements) {
            const imported = (el.propertyName ?? el.name).text
            if (imported === 'createDb') {
              forbiddenDbPoolReason = 'createDb import from @image-playground/db'
              break
            }
          }
        }
      } else if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        isDbPackage(node.moduleSpecifier.text)
      ) {
        if (!node.exportClause) {
          forbiddenDbPoolReason = 'wildcard re-export from @image-playground/db'
        } else if (ts.isNamespaceExport(node.exportClause)) {
          forbiddenDbPoolReason = 'namespace re-export from @image-playground/db'
        } else if (ts.isNamedExports(node.exportClause)) {
          for (const el of node.exportClause.elements) {
            const exported = (el.propertyName ?? el.name).text
            if (exported === 'createDb') {
              forbiddenDbPoolReason = 'createDb re-export from @image-playground/db'
              break
            }
          }
        }
      } else if (
        ts.isCallExpression(node) &&
        node.arguments.length >= 1 &&
        ts.isStringLiteralLike(node.arguments[0]!) &&
        isDbPackage(node.arguments[0]!.text) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === 'require' &&
            node.arguments.length === 1))
      ) {
        forbiddenDbPoolReason = 'dynamic import/require of @image-playground/db'
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        ts.isStringLiteral(node.moduleReference.expression) &&
        isDbPackage(node.moduleReference.expression.text)
      ) {
        forbiddenDbPoolReason = 'import=require of @image-playground/db'
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    if (forbiddenDbPoolReason) {
      violations.push(
        `[read-models-pool] packages/read-models/src/${normalized} forbidden ${forbiddenDbPoolReason} (inject DbHandle instead)`,
      )
    }
  }
  return violations
}

if (import.meta.main) {
  const repoRoot = resolve(import.meta.dir, '..')
  const [bffViolations, dbViolations, readModelsViolations] = await Promise.all([
    checkBffBoundaries(resolve(repoRoot, 'apps/bff/src')),
    checkDirAcyclic(resolve(repoRoot, 'packages/db/src'), 'packages/db/src'),
    checkReadModelsBoundaries(resolve(repoRoot, 'packages/read-models/src')),
  ])
  const allViolations = [...bffViolations, ...dbViolations, ...readModelsViolations]
  if (allViolations.length > 0) {
    console.error(
      `Architecture boundary violations (${allViolations.length}):\n${allViolations.join('\n')}`,
    )
    process.exit(1)
  }
}
