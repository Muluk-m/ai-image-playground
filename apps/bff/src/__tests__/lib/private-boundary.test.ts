import { expect, it, setDefaultTimeout } from 'bun:test'
import { rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dir, '../../../../..')

// Spawning biome or the scanner runs past bun's 5s default while the rest of the
// monorepo test run is in flight.
setDefaultTimeout(60_000)

const scanner = () => ['bun', 'run', 'scripts/check-private-boundary.ts']

// Per-case fixture paths: on one shared path a timed-out case's late cleanup
// deletes the next case's fixture.
async function scanFixture(
  name: string,
  source: string,
  command: (fixture: string) => string[],
): Promise<string> {
  const fixture = resolve(repoRoot, `apps/bff/src/private-boundary-${name}.fixture.ts`)
  writeFileSync(fixture, source)
  try {
    const child = Bun.spawn(command(fixture), { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(exitCode).not.toBe(0)
    return `${stdout}\n${stderr}`
  } finally {
    rmSync(fixture, { force: true })
  }
}

it('rejects private-tree imports outside the audited overlay seam', async () => {
  const output = await scanFixture(
    'import',
    "import '../../../../private/apps/bff/index.ts'\n",
    (fixture) => ['pnpm', 'exec', 'biome', 'lint', fixture],
  )

  expect(output).toContain(
    'Private-tree imports are only allowed at the three audited overlay seams.',
  )
})

it('rejects Vite glob and URL private-tree references outside audited seams', async () => {
  const output = await scanFixture(
    'vite',
    [
      "import.meta.glob('../../../../private/apps/web/index.tsx')",
      "new URL('../../../../private/apps/bff/index.ts', import.meta.url)",
    ].join('\n'),
    scanner,
  )

  expect(output).toContain('private-boundary-vite.fixture.ts:1')
  expect(output).toContain('private-boundary-vite.fixture.ts:2')
})

it('rejects ambient and wildcard sibling references to the private tree', async () => {
  const output = await scanFixture(
    'ambient',
    [
      "declare module '*private/apps/bff/index.ts' {}",
      "const content = '../../*/apps/web/**/*.tsx'",
    ].join('\n'),
    scanner,
  )

  expect(output).toContain('private-boundary-ambient.fixture.ts:1')
  expect(output).toContain('private-boundary-ambient.fixture.ts:2')
})
