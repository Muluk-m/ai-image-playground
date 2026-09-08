import { expect, it } from 'bun:test'
import { rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dir, '../../../../..')

// Each case gets its own fixture path: a case that times out still runs its
// cleanup later, and a shared path would delete the next case's fixture.
function fixturePath(name: string): string {
  return resolve(repoRoot, `apps/bff/src/private-boundary-${name}.fixture.ts`)
}

// Spawning biome and the scanner costs seconds when the whole monorepo test
// run is in flight, well past bun's 5s default.
const SPAWN_TIMEOUT_MS = 60_000

async function spawnCheck(command: string[]): Promise<{ exitCode: number; output: string }> {
  const child = Bun.spawn(command, { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, output: `${stdout}\n${stderr}` }
}

async function runBoundaryScanner(name: string, source: string): Promise<string> {
  const fixture = fixturePath(name)
  writeFileSync(fixture, source)
  try {
    const { exitCode, output } = await spawnCheck([
      'bun',
      'run',
      'scripts/check-private-boundary.ts',
    ])
    expect(exitCode).not.toBe(0)
    return output
  } finally {
    rmSync(fixture, { force: true })
  }
}

it(
  'rejects private-tree imports outside the audited overlay seam',
  async () => {
    const fixture = fixturePath('import')
    writeFileSync(fixture, "import '../../../../private/apps/bff/index.ts'\n")

    try {
      const { exitCode, output } = await spawnCheck(['pnpm', 'exec', 'biome', 'lint', fixture])

      expect(exitCode).not.toBe(0)
      expect(output).toContain(
        'Private-tree imports are only allowed at the three audited overlay seams.',
      )
    } finally {
      rmSync(fixture, { force: true })
    }
  },
  SPAWN_TIMEOUT_MS,
)

it(
  'rejects Vite glob and URL private-tree references outside audited seams',
  async () => {
    const output = await runBoundaryScanner(
      'vite',
      [
        "import.meta.glob('../../../../private/apps/web/index.tsx')",
        "new URL('../../../../private/apps/bff/index.ts', import.meta.url)",
      ].join('\n'),
    )

    expect(output).toContain('private-boundary-vite.fixture.ts:1')
    expect(output).toContain('private-boundary-vite.fixture.ts:2')
  },
  SPAWN_TIMEOUT_MS,
)

it(
  'rejects ambient and wildcard sibling references to the private tree',
  async () => {
    const output = await runBoundaryScanner(
      'ambient',
      [
        "declare module '*private/apps/bff/index.ts' {}",
        "const content = '../../*/apps/web/**/*.tsx'",
      ].join('\n'),
    )

    expect(output).toContain('private-boundary-ambient.fixture.ts:1')
    expect(output).toContain('private-boundary-ambient.fixture.ts:2')
  },
  SPAWN_TIMEOUT_MS,
)
