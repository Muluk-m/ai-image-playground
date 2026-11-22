import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { checkBffBoundaries, checkDirAcyclic } from '../../../../../scripts/check-arch-boundaries'

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
    const [bffViolations, dbViolations] = await Promise.all([
      checkBffBoundaries(resolve(repoRoot, 'apps/bff/src')),
      checkDirAcyclic(resolve(repoRoot, 'packages/db/src/schemas'), 'packages/db/src/schemas'),
    ])
    expect(bffViolations).toEqual([])
    expect(dbViolations).toEqual([])
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

  it('enforces ADR 0034 module facade across all callers, core-to-app DAG, and agent sub-layer order', async () => {
    const dir = createTempTree({
      'modules/media/index.ts': 'export const mediaFacade = 1\n',
      'modules/media/internal.ts': 'export const mediaSecret = 2\n',
      'modules/execution/ok.ts':
        "import { mediaFacade } from '../media'\nexport const ok = mediaFacade\n",
      'modules/execution/bad-deep.ts':
        "import { mediaSecret } from '../media/internal'\nexport const bad = mediaSecret\n",
      'modules/execution/bad-upward.ts':
        "import { agentFacade } from '../agent'\nexport const up = agentFacade\n",
      'delivery/http/bad-deep.ts':
        "import { mediaSecret } from '../../modules/media/internal'\nexport const d = mediaSecret\n",
      'bootstrap/container.ts':
        "import { mediaSecret } from '../modules/media/internal'\nexport const c = mediaSecret\n",
      'modules/agent/index.ts': 'export const agentFacade = 1\n',
      'modules/agent/contracts/types.ts': 'export const tag = "a"\n',
      'modules/agent/conversation/bad.ts':
        "import { rt } from '../runtime/exec'\nexport const c = rt\n",
      'modules/agent/runtime/exec.ts':
        "import { tag } from '../contracts/types'\nexport const rt = tag\n",
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
        v.includes('[module-encapsulation] delivery/http/bad-deep.ts -> modules/media/internal.ts'),
      ),
    ).toBe(true)
    expect(
      violations.some((v) =>
        v.includes(
          '[core -> app-module] modules/execution/bad-upward.ts -> modules/agent/index.ts',
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
    expect(violations).toHaveLength(4)
    expect(violations.some((v) => v.includes('modules/execution/ok.ts ->'))).toBe(false)
    expect(violations.some((v) => v.includes('modules/agent/runtime/exec.ts ->'))).toBe(false)
    expect(violations.some((v) => v.includes('bootstrap/container.ts ->'))).toBe(false)
  })

  it('rejects new runtime cycles while ignoring type-only cycles and scanning TSX JSX files cleanly', async () => {
    const dir = createTempTree({
      'lib/a.ts': "import { b } from './b'\nexport const a = () => b()\n",
      'lib/b.ts': "import { a } from './a'\nexport const b = () => a()\n",
      'lib/t1.ts': "import type { T2 } from './t2'\nexport interface T1 { x?: T2 }\n",
      'lib/t2.ts': "import type { T1 } from './t1'\nexport interface T2 { y?: T1 }\n",
      'lib/view.tsx': 'export const View = () => <div />\n',
    })

    const violations = await checkBffBoundaries(dir)
    expect(violations).toEqual([
      '[import-cycle] runtime cycle in apps/bff/src: lib/a.ts <-> lib/b.ts',
    ])
  })
})
