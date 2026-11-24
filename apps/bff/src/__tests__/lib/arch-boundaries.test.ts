import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import {
  checkBffBoundaries,
  checkDirAcyclic,
  checkReadModelsBoundaries,
} from '../../../../../scripts/check-arch-boundaries'

const repoRoot = resolve(import.meta.dir, '../../../../..')
const tempDirs: string[] = []

function createTempTree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'arch-boundaries-'))
  tempDirs.push(dir)
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(dir, relPath)
    mkdirSync(dirname(fullPath), { recursive: true })
    writeFileSync(fullPath, content)
  }
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('check-arch-boundaries', () => {
  it('passes against the current repository baseline', async () => {
    const [bffViolations, dbViolations, readModelsViolations] = await Promise.all([
      checkBffBoundaries(resolve(repoRoot, 'apps/bff/src')),
      checkDirAcyclic(resolve(repoRoot, 'packages/db/src'), 'packages/db/src'),
      checkReadModelsBoundaries(resolve(repoRoot, 'packages/read-models/src')),
    ])
    expect(bffViolations).toEqual([])
    expect(dbViolations).toEqual([])
    expect(readModelsViolations).toEqual([])
  })

  it('rejects new routes -> db, db -> non-db, and workers -> agent imports (including .js specifiers and relative rootDir)', async () => {
    const dir = createTempTree({
      'db/client.ts': 'export const db = {}\n',
      'db/bad.ts': "import { helper } from '../lib/helper'\nexport const x = helper\n",
      'lib/helper.ts': 'export const helper = 1\n',
      'lib/agent/secret.ts': 'export const secret = 1\n',
      'routes/new-route.ts': "import { db } from '../db/client.js'\nexport const r = db\n",
      'delivery/http/orders.ts': "import { db } from '../../db/client'\nexport const o = db\n",
      'workers/new-worker.ts':
        "import { secret } from '../lib/agent/secret'\nexport const w = secret\n",
    })

    const relativeDir = relative(process.cwd(), dir)
    const violations = await checkBffBoundaries(`${relativeDir}/`)
    expect(
      violations.some((v) => v.includes('[routes -> db] routes/new-route.ts -> db/client.ts')),
    ).toBe(true)
    expect(
      violations.some((v) => v.includes('[routes -> db] delivery/http/orders.ts -> db/client.ts')),
    ).toBe(true)
    expect(violations.some((v) => v.includes('[db -> non-db] db/bad.ts -> lib/helper.ts'))).toBe(
      true,
    )
    expect(
      violations.some((v) =>
        v.includes('[workers -> agent] workers/new-worker.ts -> lib/agent/secret.ts'),
      ),
    ).toBe(true)
  })

  it('enforces ADR 0034 module facade, core-to-app DAG, and agent sub-layer order for both runtime and type-only imports', async () => {
    const dir = createTempTree({
      'modules/media/index.ts': 'export const mediaFacade = 1\n',
      'modules/media/contracts/index.ts': 'export const mediaContract = 1\n',
      'modules/media/internal.ts':
        'export interface MediaSecret { id: string }\nexport const mediaSecret = 2\n',
      'modules/execution/ok.ts':
        "import { mediaFacade } from '../media'\nexport const ok = mediaFacade\n",
      'modules/execution/bad-media-contracts.ts':
        "import { mediaContract } from '../media/contracts'\nexport const badContract = mediaContract\n",
      'modules/execution/bad-deep.ts':
        "import { mediaSecret } from '../media/internal'\nexport const bad = mediaSecret\n",
      'modules/execution/bad-deep-type.ts':
        "import type { MediaSecret } from '../media/internal'\nexport type BadType = MediaSecret\n",
      'modules/execution/bad-import-equals.ts':
        "import type AgentRuntime = require('../agent/runtime/exec')\nexport type EqType = AgentRuntime.RuntimeState\n",
      'modules/execution/bad-upward-type.ts': "export type { AgentFacade } from '../agent'\n",
      'modules/execution/bad-legacy-lib.ts':
        "import { publishProjectOutputs } from '../../lib/projectArchive'\nexport const p = publishProjectOutputs\n",
      'lib/projectArchive.ts': 'export const publishProjectOutputs = () => {}\n',
      'delivery/http/bad-deep.ts':
        "import { mediaSecret } from '../../modules/media/internal'\nexport const d = mediaSecret\n",
      'bootstrap/container.ts':
        "import { mediaSecret } from '../modules/media/internal'\nexport const c = mediaSecret\n",
      'modules/agent/index.ts': 'export interface AgentFacade { ok: boolean }\n',
      'modules/agent/contracts/index.ts': "export { tag } from './types'\n",
      'modules/agent/contracts/types.ts': 'export const tag = "a"\n',
      'modules/agent/contracts/bad-legacy.ts':
        "import type { Legacy } from '../../../lib/agent/legacy'\nexport type BadLegacy = Legacy\n",
      'modules/agent/contracts/bad-env.ts':
        "import { readCfg } from '../../../lib/channels'\nexport const badEnv = readCfg\n",
      'config.ts': 'export const config = {}\n',
      'lib/channels.ts':
        "import { config } from '../config'\nexport const readCfg = () => config\n",
      'lib/agent/legacy.ts': 'export interface Legacy { id: string }\n',
      'lib/agent/pure-ok.ts':
        "import { tag } from '../../modules/agent/contracts'\nexport const pureOk = tag\n",
      'lib/agent/core-bad.ts':
        "import { helper } from './tools/helper'\nexport const badToolDep = helper\n",
      'lib/agent/tools/helper.ts': 'export const helper = 1\n',
      'modules/agent/conversation/bad.ts':
        "import type { RuntimeState } from '../runtime/exec'\nexport type C = RuntimeState\n",
      'modules/agent/conversation/bad-facade.ts':
        "import type { AgentFacade } from '..'\nexport type BadFacade = AgentFacade\n",
      'modules/agent/conversation/bad-legacy.ts':
        "import type { Legacy } from '../../../lib/agent/legacy'\nexport type BadConvLegacy = Legacy\n",
      'modules/agent/inbox/bad-legacy.ts':
        "import type { Legacy } from '../../../lib/agent/legacy'\nexport type BadInboxLegacy = Legacy\n",
      'modules/agent/inbox/bad-up.ts':
        "import type { RuntimeState } from '../runtime/exec'\nexport type BadInboxUp = RuntimeState\n",
      'modules/agent/runtime/exec.ts':
        "import { tag } from '../contracts/types'\nexport interface RuntimeState { tag: string }\nexport const rt = tag\n",
      'modules/agent/runtime/bad-tool.ts':
        "import { helper } from '../../../lib/agent/tools/helper'\nexport const badTool = helper\n",
      'modules/agent/runtime/bad-fanout.ts': [
        "import { a } from 'pkg-1'",
        "import { b } from 'pkg-2'",
        "import { c } from 'pkg-3'",
        "import { d } from 'pkg-4'",
        "import { e } from 'pkg-5'",
        "import { f } from 'pkg-6'",
        "import { g } from 'pkg-7'",
        "import { h } from 'pkg-8'",
        "import { i } from 'pkg-9'",
        "import { j } from 'pkg-10'",
        "import { k } from 'pkg-11'",
        "import { l } from 'pkg-12'",
        'export const all = [a, b, c, d, e, f, g, h, i, j, k, l]',
      ].join('\n'),
      'modules/canvas/index.ts': 'export const canvasOp = 1\n',
      'modules/canvas/bad-agent.ts':
        "import { tag } from '../agent/contracts'\nexport const badCanvasAgent = tag\n",
      'modules/canvas/bad-legacy.ts':
        "import type { Legacy } from '../../lib/agent/legacy'\nexport type BadCanvasLegacy = Legacy\n",
      'modules/agent/inbox/item.ts': 'export const inboxItem = 1\n',
      'modules/agent/tools/index.ts': "export { reg } from './registry'\n",
      'modules/agent/tools/registry.ts': 'export const reg = 1\n',
      'modules/agent/tools/adapter.ts':
        "import type { reg } from './registry'\nimport { genTool } from './generation/gen'\nexport type BadAdapterReg = typeof reg\nexport const badAdapterGen = genTool\n",
      'modules/agent/tools/generation/gen.ts': 'export const genTool = 1\n',
      'modules/agent/tools/analysis/bad-future-domain.ts':
        "import { genTool } from '../generation/gen'\nimport { reg } from '../registry'\nexport const badFuture = [genTool, reg]\n",
      'modules/agent/tools/canvas/ok.ts':
        "import { canvasOp } from '../../../canvas'\nimport { tag } from '../../contracts'\nexport const okCanvasTool = [canvasOp, tag]\n",
      'modules/agent/tools/canvas/bad-runtime.ts':
        "import { rt } from '../../runtime/exec'\nexport const badRt = rt\n",
      'modules/agent/tools/canvas/bad-inbox.ts':
        "import { inboxItem } from '../../inbox/item'\nexport const badIn = inboxItem\n",
      'modules/agent/tools/canvas/bad-inter-tool.ts':
        "import { genTool } from '../generation/gen'\nexport const badInter = genTool\n",
      'modules/agent/tools/canvas/bad-registry.ts':
        "import { reg } from '../registry'\nexport const badReg = reg\n",
      'modules/agent/tools/web/bad-legacy-tools.ts':
        "import { helper } from '../../../../lib/agent/tools/helper'\nexport const badLT = helper\n",
      'modules/agent/tools/web/bad-shim.ts':
        "import { ev } from '../../../../lib/agent/events'\nimport { qa } from '../../../../lib/agent/job-artifacts'\nexport const badShim = [ev, qa]\n",
      'lib/agent/events.ts': 'export const ev = 1\n',
      'lib/agent/job-artifacts.ts': 'export const qa = 1\n',
      'lib/agent/tools/index.ts': 'export const legacyTools = 1\n',
      'lib/agent/turn.ts':
        "import { legacyTools } from './tools'\nexport const badTurnCore = legacyTools\n",
      'lib/agent/interrupted.ts':
        "import { reg } from '../../modules/agent/tools'\nexport const okWhitelistedCaller = reg\n",
      'lib/agent/bad-tools-caller.ts':
        "import { reg } from '../../modules/agent/tools'\nexport const badCaller = reg\n",
      'modules/agent/orchestration/index.ts': 'export const orchFacade = 1\n',
      'modules/agent/orchestration/masked/mask-ok.ts': 'export const maskOk = 1\n',
      'modules/agent/orchestration/masked/pure.ts':
        "import { readCfg } from '../../../../lib/channels'\nexport const badPure = readCfg\n",
      'modules/agent/orchestration/batch/ok.ts':
        "import { maskOk } from '../masked/mask-ok'\nexport const okBatchMasked = maskOk\n",
      'modules/agent/orchestration/batch/bad-prod.ts':
        "import { prodVal } from '../production/prod-ok'\nexport const badBatchProd = prodVal\n",
      'modules/agent/orchestration/batch/bad-facade.ts':
        "import { orchFacade } from '..'\nexport const badOrchFacade = orchFacade\n",
      'modules/agent/orchestration/production/prod-ok.ts': 'export const prodVal = 1\n',
      'modules/agent/orchestration/production/bad-batch.ts':
        "import { okBatchMasked } from '../batch/ok'\nexport const badProdBatch = okBatchMasked\n",
      'modules/agent/orchestration/production/bad-runtime.ts':
        "import { rt } from '../../runtime/exec'\nexport const badOrchRt = rt\n",
      'modules/agent/orchestration/production/bad-tools.ts':
        "import { genTool } from '../../tools/generation/gen'\nexport const badOrchTools = genTool\n",
      'modules/agent/orchestration/production/bad-legacy.ts':
        "import { helper } from '../../../../lib/agent/tools/helper'\nimport { ev } from '../../../../lib/agent/events'\nexport const badOrchLegacy = [helper, ev]\n",
      'lib/agent/batch-plans.ts': 'export const legacyBatchPlan = 1\n',
      'modules/agent/runtime/bad-orch.ts':
        "import { prodVal } from '../orchestration/production/prod-ok'\nimport { legacyBatchPlan } from '../../../lib/agent/batch-plans'\nexport const badRtOrch = [prodVal, legacyBatchPlan]\n",
    })

    const violations = await checkBffBoundaries(dir)
    expect(
      violations.some((v) =>
        v.includes(
          '[module-encapsulation] modules/execution/bad-deep.ts -> modules/media/internal.ts',
        ),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.includes(
          '[module-encapsulation] modules/execution/bad-deep-type.ts -> modules/media/internal.ts',
        ),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.includes(
          '[module-encapsulation] modules/execution/bad-import-equals.ts -> modules/agent/runtime/exec.ts',
        ),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.includes(
          '[core -> app-module] modules/execution/bad-import-equals.ts -> modules/agent/runtime/exec.ts',
        ),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.includes('[module-encapsulation] delivery/http/bad-deep.ts -> modules/media/internal.ts'),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.includes(
          '[core -> app-module] modules/execution/bad-upward-type.ts -> modules/agent/index.ts',
        ),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.includes(
          '[execution -> legacy-lib] modules/execution/bad-legacy-lib.ts -> lib/projectArchive.ts',
        ),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.includes(
          '[agent-layer] modules/agent/conversation/bad.ts -> modules/agent/runtime/exec.ts',
        ),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.includes(
          '[agent-contracts -> legacy-agent] modules/agent/contracts/bad-legacy.ts -> lib/agent/legacy.ts',
        ),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.includes(
          '[agent-conversation -> legacy-agent] modules/agent/conversation/bad-legacy.ts -> lib/agent/legacy.ts',
        ),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.includes(
          '[agent-inbox -> legacy-agent] modules/agent/inbox/bad-legacy.ts -> lib/agent/legacy.ts',
        ),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.includes('[agent-layer] modules/agent/inbox/bad-up.ts -> modules/agent/runtime/exec.ts'),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.includes(
          '[agent-contracts -> runtime-env] modules/agent/contracts/bad-env.ts -> config.ts (via lib/channels.ts)',
        ),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.includes(
          '[module-encapsulation] modules/execution/bad-media-contracts.ts -> modules/media/contracts/index.ts',
        ),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.includes(
          '[agent-layer] modules/agent/conversation/bad-facade.ts -> modules/agent/index.ts',
        ),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.includes(
          '[agent-runtime -> legacy-tools] modules/agent/runtime/bad-tool.ts -> lib/agent/tools/helper.ts',
        ),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.includes('[agent-runtime-fanout] modules/agent/runtime/bad-fanout.ts imports 12 modules'),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.includes('[agent-core -> tools] lib/agent/core-bad.ts -> lib/agent/tools/helper.ts'),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.includes('[agent-core -> tools] lib/agent/turn.ts -> lib/agent/tools/index.ts'),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.includes(
          '[canvas -> agent] modules/canvas/bad-agent.ts -> modules/agent/contracts/index.ts',
        ),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.includes('[canvas -> agent] modules/canvas/bad-legacy.ts -> lib/agent/legacy.ts'),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.includes(
          '[agent-tools -> runtime] modules/agent/tools/canvas/bad-runtime.ts -> modules/agent/runtime/exec.ts',
        ),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.includes(
          '[agent-tools -> inbox] modules/agent/tools/canvas/bad-inbox.ts -> modules/agent/inbox/item.ts',
        ),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.includes(
          '[agent-tools -> inter-tool] modules/agent/tools/canvas/bad-inter-tool.ts -> modules/agent/tools/generation/gen.ts',
        ),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.includes(
          '[agent-tools -> registry] modules/agent/tools/canvas/bad-registry.ts -> modules/agent/tools/registry.ts',
        ),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.includes(
          '[agent-tools -> legacy-tools] modules/agent/tools/web/bad-legacy-tools.ts -> lib/agent/tools/helper.ts',
        ),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.includes(
          '[agent-tools -> legacy-agent-layer] modules/agent/tools/web/bad-shim.ts -> lib/agent/events.ts',
        ),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.includes(
          '[agent-tools -> legacy-agent-layer] modules/agent/tools/web/bad-shim.ts -> lib/agent/job-artifacts.ts',
        ),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.includes(
          '[agent-tools -> adapter-upward] modules/agent/tools/adapter.ts -> modules/agent/tools/registry.ts',
        ),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.includes(
          '[agent-tools -> adapter-upward] modules/agent/tools/adapter.ts -> modules/agent/tools/generation/gen.ts',
        ),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.includes(
          '[agent-tools -> inter-tool] modules/agent/tools/analysis/bad-future-domain.ts -> modules/agent/tools/generation/gen.ts',
        ),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.includes(
          '[agent-tools -> registry] modules/agent/tools/analysis/bad-future-domain.ts -> modules/agent/tools/registry.ts',
        ),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.includes(
          '[agent-core -> module-tools] lib/agent/bad-tools-caller.ts -> modules/agent/tools/index.ts',
        ),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.includes(
          '[agent-orchestration -> subdomain] modules/agent/orchestration/batch/bad-prod.ts -> modules/agent/orchestration/production/prod-ok.ts',
        ),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.includes(
          '[agent-orchestration -> facade] modules/agent/orchestration/batch/bad-facade.ts -> modules/agent/orchestration/index.ts',
        ),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.includes(
          '[agent-orchestration -> subdomain] modules/agent/orchestration/production/bad-batch.ts -> modules/agent/orchestration/batch/ok.ts',
        ),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.includes(
          '[agent-orchestration -> runtime] modules/agent/orchestration/production/bad-runtime.ts -> modules/agent/runtime/exec.ts',
        ),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.includes(
          '[agent-layer] modules/agent/orchestration/production/bad-tools.ts -> modules/agent/tools/generation/gen.ts',
        ),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.includes(
          '[agent-orchestration -> legacy-tools] modules/agent/orchestration/production/bad-legacy.ts -> lib/agent/tools/helper.ts',
        ),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.includes(
          '[agent-orchestration -> legacy-agent-layer] modules/agent/orchestration/production/bad-legacy.ts -> lib/agent/events.ts',
        ),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.includes(
          '[agent-layer] modules/agent/runtime/bad-orch.ts -> modules/agent/orchestration/production/prod-ok.ts',
        ),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.includes(
          '[agent-runtime -> legacy-agent-layer] modules/agent/runtime/bad-orch.ts -> lib/agent/batch-plans.ts',
        ),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.includes(
          '[agent-masked-pure -> runtime-env] modules/agent/orchestration/masked/pure.ts -> config.ts (via lib/channels.ts)',
        ),
      ),
    ).toBe(true)
    expect(violations).toHaveLength(43)
    expect(violations.some((v) => v.includes('lib/agent/pure-ok.ts ->'))).toBe(false)
    expect(violations.some((v) => v.includes('lib/agent/interrupted.ts ->'))).toBe(false)
    expect(violations.some((v) => v.includes('modules/agent/tools/canvas/ok.ts ->'))).toBe(false)
    expect(violations.some((v) => v.includes('modules/agent/orchestration/batch/ok.ts ->'))).toBe(
      false,
    )
    expect(violations.some((v) => v.includes('modules/execution/ok.ts ->'))).toBe(false)
    expect(violations.some((v) => v.includes('modules/agent/runtime/exec.ts ->'))).toBe(false)
    expect(violations.some((v) => v.includes('bootstrap/container.ts ->'))).toBe(false)
  })

  it('rejects any runtime import cycle (zero-cycle baseline) while ignoring type-only cycles and scanning TSX JSX cleanly', async () => {
    const dir = createTempTree({
      'lib/a.ts': "import { b } from './b'\nexport const a = b\n",
      'lib/b.ts': "import { a } from './a'\nexport const b = a\n",
      'lib/t1.ts': "import type { T2 } from './t2'\nexport interface T1 { x?: T2 }\n",
      'lib/t2.ts': "import type { T1 } from './t1'\nexport interface T2 { y?: T1 }\n",
      'lib/view.tsx': 'export const View = () => <div />\n',
    })

    const violations = await checkBffBoundaries(dir)
    expect(violations).toHaveLength(2)
    expect(
      violations.some((v) =>
        v.includes('[import-cycle] new runtime cycle edge: lib/a.ts -> lib/b.ts'),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.includes('[import-cycle] new runtime cycle edge: lib/b.ts -> lib/a.ts'),
      ),
    ).toBe(true)
  })

  it('catches DB schema cycles routed back through the barrel schema.ts', async () => {
    const dir = createTempTree({
      'schema.ts': "export * from './schemas/execution'\nexport * from './schemas/identity'\n",
      'schemas/identity.ts': 'export const users = {}\n',
      'schemas/execution.ts': "import { users } from '../schema'\nexport const tasks = { users }\n",
    })

    const violations = await checkDirAcyclic(dir, 'packages/db/src')
    expect(violations).toEqual([
      '[import-cycle] runtime cycle in packages/db/src: schema.ts <-> schemas/execution.ts',
    ])
  })

  it('enforces read-models pool ban, acyclicity, and browser-safe types.ts allowlist', async () => {
    const dir = createTempTree({
      'types.ts':
        "import type { TaskStatus } from '@image-playground/shared'\nimport { helper } from './sql-helpers'\nimport { createHash } from 'node:crypto'\nexport type X = TaskStatus\nexport const y = [helper, createHash]\n",
      'sql-helpers.ts': 'export const helper = 1\n',
      'bad-bun-sql.ts': "import { SQL } from 'bun:sql'\nexport const s = SQL\n",
      'bad-postgres.ts': "import postgres from 'postgres'\nexport const p = postgres\n",
      'bad-ns.ts': "import * as dbPkg from '@image-playground/db'\nexport const n = dbPkg\n",
      'bad-dyn.ts': "export const load = () => import('@image-playground/db')\n",
      'bad-dyn-opts.ts': "export const loadOpts = () => import('@image-playground/db', {})\n",
      'bad-reexport.ts': "export { createDb } from '@image-playground/db'\n",
      'bad-ns-reexport.ts': "export * as db from '@image-playground/db'\n",
      'bad-star-reexport.ts': "export * from '@image-playground/db'\n",
      'ok.ts':
        "import { OAUTH_ONLY_PASSWORD_HASH, type DbHandle } from '@image-playground/db'\nexport type H = DbHandle\nexport const h = OAUTH_ONLY_PASSWORD_HASH\n",
    })

    const violations = await checkReadModelsBoundaries(dir)
    expect(violations.some((v) => v.includes('types.ts must not import ./sql-helpers'))).toBe(true)
    expect(violations.some((v) => v.includes('types.ts must not import node:crypto'))).toBe(true)
    expect(violations.some((v) => v.includes('bad-bun-sql.ts must not import bun:sql'))).toBe(true)
    expect(violations.some((v) => v.includes('bad-postgres.ts must not import postgres'))).toBe(
      true,
    )
    expect(violations.some((v) => v.includes('bad-ns.ts forbidden namespace import'))).toBe(true)
    expect(violations.some((v) => v.includes('bad-dyn.ts forbidden dynamic import/require'))).toBe(
      true,
    )
    expect(
      violations.some((v) => v.includes('bad-dyn-opts.ts forbidden dynamic import/require')),
    ).toBe(true)
    expect(violations.some((v) => v.includes('bad-reexport.ts forbidden createDb re-export'))).toBe(
      true,
    )
    expect(
      violations.some((v) => v.includes('bad-ns-reexport.ts forbidden namespace re-export')),
    ).toBe(true)
    expect(
      violations.some((v) => v.includes('bad-star-reexport.ts forbidden wildcard re-export')),
    ).toBe(true)
    expect(violations.some((v) => v.includes('ok.ts'))).toBe(false)
    expect(violations).toHaveLength(10)
  })
})
