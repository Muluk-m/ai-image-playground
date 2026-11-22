import { existsSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

/**
 * 服务端架构边界棘轮（ADR 0034）：
 * 1. 锁死存量跨层反向依赖与运行时循环依赖白名单——只许减少、禁止新增。
 * 2. 对新建的模块化单体目录（modules/<bc>/、delivery/http/）从第一天起执行零容忍硬规则。
 * 3. 保证 packages/db/src/schemas/ 保持无环 DAG。
 */

const tsTranspiler = new Bun.Transpiler({ loader: 'ts' })
const tsxTranspiler = new Bun.Transpiler({ loader: 'tsx' })
const sourceGlob = new Bun.Glob('**/*.{ts,tsx}')

const ALLOWED_ROUTE_TO_DB = new Set([
  'routes/agent-batches.ts -> db/client.ts',
  'routes/agent.ts -> db/client.ts',
  'routes/auth.ts -> db/client.ts',
  'routes/cancel.ts -> db/client.ts',
  'routes/cancel.ts -> db/task-transitions.ts',
  'routes/canvasSync.ts -> db/client.ts',
  'routes/internal-ops.ts -> db/client.ts',
  'routes/looks.ts -> db/client.ts',
  'routes/result.ts -> db/client.ts',
  'routes/status.ts -> db/client.ts',
  'routes/submit.ts -> db/client.ts',
])

const ALLOWED_DB_TO_OUTSIDE = new Set([
  'db/client.ts -> config.ts',
  'db/maintenance.ts -> config.ts',
  'db/maintenance.ts -> lib/agent/batch-progress.ts',
  'db/maintenance.ts -> lib/agent/conversations.ts',
  'db/maintenance.ts -> lib/durableMediaStore.ts',
  'db/maintenance.ts -> lib/logger.ts',
  'db/maintenance.ts -> lib/objectStore.ts',
  'db/maintenance.ts -> lib/private-overlay.ts',
  'db/maintenance.ts -> lib/retry.ts',
  'db/maintenance.ts -> lib/sync-assets.ts',
  'db/migrate.ts -> config.ts',
  'db/migrate.ts -> lib/capabilities.ts',
  'db/migrate.ts -> lib/private-overlay.ts',
  'db/task-transitions.ts -> lib/agent/wake.ts',
  'db/task-transitions.ts -> lib/generationMedia.ts',
  'db/task-transitions.ts -> lib/model-availability.ts',
  'db/task-transitions.ts -> lib/private-overlay.ts',
  'db/task-transitions.ts -> lib/projectArchive.ts',
  'db/task-transitions.ts -> lib/upstream/partial.ts',
])

const ALLOWED_WORKERS_TO_AGENT = new Set([
  'workers/analysis-runner.ts -> lib/agent/request-budget.ts',
  'workers/analysis-runner.ts -> lib/agent/tools/errors.ts',
  'workers/analysis-runner.ts -> lib/agent/visual-resources.ts',
  'workers/task-runner.ts -> lib/agent/masked-input.ts',
  'workers/task-runner.ts -> lib/agent/masked-output.ts',
  'workers/task-scheduler.ts -> lib/agent/batch-execution.ts',
])

const ALLOWED_RUNTIME_CYCLES = new Set([
  [
    'lib/agent/batch-analysis-preparation.ts',
    'lib/agent/batch-execution.ts',
    'lib/agent/batch-phase-edit.ts',
    'lib/agent/batch-plan-revision.ts',
    'lib/agent/batch-plans.ts',
  ].join(' <-> '),
  ['lib/upstream/gpt-direct-admin.ts', 'lib/upstream/gpt-keys.ts'].join(' <-> '),
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

async function buildImportGraph(rootDir: string): Promise<{
  files: string[]
  adjacency: Map<string, string[]>
}> {
  const normalizedRoot = resolve(rootDir)
  const files: string[] = []
  if (!existsSync(normalizedRoot)) return { files, adjacency: new Map() }

  for await (const file of sourceGlob.scan({ cwd: normalizedRoot, onlyFiles: true })) {
    const normalized = file.replaceAll('\\', '/')
    if (normalized.includes('__tests__')) continue
    files.push(normalized)
  }
  files.sort()

  const adjacency = new Map<string, string[]>()
  for (const file of files) {
    const text = await Bun.file(resolve(normalizedRoot, file)).text()
    const transpiler = file.endsWith('.tsx') ? tsxTranspiler : tsTranspiler
    const targets = new Set<string>()
    for (const imp of transpiler.scanImports(text)) {
      if (
        imp.kind !== 'import-statement' &&
        imp.kind !== 'dynamic-import' &&
        imp.kind !== 'require-call'
      ) {
        continue
      }
      const target = resolveInternalTarget(normalizedRoot, file, imp.path)
      if (target && target !== file) targets.add(target)
    }
    adjacency.set(file, [...targets].sort())
  }
  return { files, adjacency }
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
  const { files, adjacency } = await buildImportGraph(bffRoot)
  const violations: string[] = []

  for (const file of files) {
    const fromModule = moduleOf(file)

    for (const target of adjacency.get(file) ?? []) {
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
        if (!ALLOWED_WORKERS_TO_AGENT.has(edge)) {
          violations.push(
            `[workers -> agent] ${edge} is not allowed (keep queue workers decoupled from agent)`,
          )
        }
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

  for (const cycle of findStronglyConnectedCycles(files, adjacency)) {
    const key = cycle.join(' <-> ')
    if (!ALLOWED_RUNTIME_CYCLES.has(key)) {
      violations.push(`[import-cycle] runtime cycle in apps/bff/src: ${key}`)
    }
  }

  return violations
}

export async function checkDirAcyclic(rootDir: string, label: string): Promise<string[]> {
  const { files, adjacency } = await buildImportGraph(rootDir)
  return findStronglyConnectedCycles(files, adjacency).map(
    (cycle) => `[import-cycle] runtime cycle in ${label}: ${cycle.join(' <-> ')}`,
  )
}

if (import.meta.main) {
  const repoRoot = resolve(import.meta.dir, '..')
  const [bffViolations, dbSchemaViolations] = await Promise.all([
    checkBffBoundaries(resolve(repoRoot, 'apps/bff/src')),
    checkDirAcyclic(resolve(repoRoot, 'packages/db/src/schemas'), 'packages/db/src/schemas'),
  ])
  const allViolations = [...bffViolations, ...dbSchemaViolations]
  if (allViolations.length > 0) {
    console.error(
      `Architecture boundary violations (${allViolations.length}):\n${allViolations.join('\n')}`,
    )
    process.exit(1)
  }
}
