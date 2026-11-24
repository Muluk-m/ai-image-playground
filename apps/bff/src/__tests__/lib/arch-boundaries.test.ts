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
      'modules/media/internal.ts':
        'export interface MediaSecret { id: string }\nexport const mediaSecret = 2\n',
      'modules/execution/ok.ts':
        "import { mediaFacade } from '../media'\nexport const ok = mediaFacade\n",
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
      'modules/agent/contracts/types.ts': 'export const tag = "a"\n',
      'modules/agent/contracts/bad-legacy.ts':
        "import type { Legacy } from '../../../lib/agent/legacy'\nexport type BadLegacy = Legacy\n",
      'modules/agent/contracts/bad-env.ts':
        "import { readCfg } from '../../../lib/channels'\nexport const badEnv = readCfg\n",
      'config.ts': 'export const config = {}\n',
      'lib/channels.ts':
        "import { config } from '../config'\nexport const readCfg = () => config\n",
      'lib/agent/legacy.ts': 'export interface Legacy { id: string }\n',
      'lib/agent/core-bad.ts':
        "import { helper } from './tools/helper'\nexport const badToolDep = helper\n",
      'lib/agent/tools/helper.ts': 'export const helper = 1\n',
      'modules/agent/conversation/bad.ts':
        "import type { RuntimeState } from '../runtime/exec'\nexport type C = RuntimeState\n",
      'modules/agent/runtime/exec.ts':
        "import { tag } from '../contracts/types'\nexport interface RuntimeState { tag: string }\nexport const rt = tag\n",
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
          '[agent-contracts -> runtime-env] modules/agent/contracts/bad-env.ts -> config.ts (via lib/channels.ts)',
        ),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.includes('[agent-core -> tools] lib/agent/core-bad.ts -> lib/agent/tools/helper.ts'),
      ),
    ).toBe(true)
    expect(violations).toHaveLength(11)
    expect(violations.some((v) => v.includes('modules/execution/ok.ts ->'))).toBe(false)
    expect(violations.some((v) => v.includes('modules/agent/runtime/exec.ts ->'))).toBe(false)
    expect(violations.some((v) => v.includes('bootstrap/container.ts ->'))).toBe(false)
  })

  it('ratchets runtime cycles at directed-edge granularity while ignoring type-only cycles and scanning TSX JSX cleanly', async () => {
    // 1. Adding a new directed edge inside an existing SCC must fail even when member nodes stay identical.
    const addedEdgeDir = createTempTree({
      'lib/agent/batch-analysis-preparation.ts':
        "import { p } from './batch-plans'\nimport { e } from './batch-execution'\nexport const prep = [p, e]\n",
      'lib/agent/batch-execution.ts': "import { p } from './batch-plans'\nexport const e = p\n",
      'lib/agent/batch-phase-edit.ts':
        "import { prep } from './batch-analysis-preparation'\nimport { e } from './batch-execution'\nimport { r } from './batch-plan-revision'\nimport { p } from './batch-plans'\nexport const edit = [prep, e, r, p]\n",
      'lib/agent/batch-plan-revision.ts': "import { p } from './batch-plans'\nexport const r = p\n",
      'lib/agent/batch-plans.ts':
        "import { prep } from './batch-analysis-preparation'\nimport { edit } from './batch-phase-edit'\nexport const p = [prep, edit]\n",
      'lib/t1.ts': "import type { T2 } from './t2'\nexport interface T1 { x?: T2 }\n",
      'lib/t2.ts': "import type { T1 } from './t1'\nexport interface T2 { y?: T1 }\n",
      'lib/view.tsx': 'export const View = () => <div />\n',
    })

    const addedEdgeViolations = await checkBffBoundaries(addedEdgeDir)
    expect(addedEdgeViolations).toHaveLength(1)
    expect(addedEdgeViolations[0]).toContain(
      '[import-cycle] new runtime cycle edge: lib/agent/batch-analysis-preparation.ts -> lib/agent/batch-execution.ts',
    )

    // 2. Shrinking an existing SCC by removing edges must pass (incremental cycle breaking).
    const shrunkDir = createTempTree({
      'lib/agent/batch-analysis-preparation.ts':
        "import { p } from './batch-plans'\nexport const prep = p\n",
      'lib/agent/batch-plans.ts':
        "import { prep } from './batch-analysis-preparation'\nexport const p = prep\n",
    })
    expect(await checkBffBoundaries(shrunkDir)).toEqual([])
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
