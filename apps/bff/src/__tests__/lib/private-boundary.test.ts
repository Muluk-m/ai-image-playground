import { expect, it } from 'bun:test'
import { rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

it('rejects private-tree imports outside the audited overlay seam', async () => {
  const repoRoot = resolve(import.meta.dir, '../../../../..')
  const fixture = resolve(repoRoot, 'apps/bff/src/private-boundary-violation.fixture.ts')
  writeFileSync(fixture, "import '../../../../private/apps/bff/index.ts'\n")

  try {
    const child = Bun.spawn(['pnpm', 'exec', 'biome', 'lint', fixture], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])

    expect(exitCode).not.toBe(0)
    expect(`${stdout}\n${stderr}`).toContain(
      'Private-tree imports are only allowed at the three audited overlay seams.',
    )
  } finally {
    rmSync(fixture, { force: true })
  }
})

it('rejects Vite glob and URL private-tree references outside audited seams', async () => {
  const repoRoot = resolve(import.meta.dir, '../../../../..')
  const fixture = resolve(repoRoot, 'apps/bff/src/private-boundary-violation.fixture.ts')
  writeFileSync(
    fixture,
    [
      "import.meta.glob('../../../../private/apps/web/index.tsx')",
      "new URL('../../../../private/apps/bff/index.ts', import.meta.url)",
    ].join('\n'),
  )

  try {
    const child = Bun.spawn(['bun', 'run', 'scripts/check-private-boundary.ts'], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])

    expect(exitCode).not.toBe(0)
    expect(`${stdout}\n${stderr}`).toContain('private-boundary-violation.fixture.ts:1')
    expect(`${stdout}\n${stderr}`).toContain('private-boundary-violation.fixture.ts:2')
  } finally {
    rmSync(fixture, { force: true })
  }
})

it('rejects ambient and wildcard sibling references to the private tree', async () => {
  const repoRoot = resolve(import.meta.dir, '../../../../..')
  const fixture = resolve(repoRoot, 'apps/bff/src/private-boundary-violation.fixture.ts')
  writeFileSync(
    fixture,
    [
      "declare module '*private/apps/bff/index.ts' {}",
      "const content = '../../*/apps/web/**/*.tsx'",
    ].join('\n'),
  )

  try {
    const child = Bun.spawn(['bun', 'run', 'scripts/check-private-boundary.ts'], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])

    expect(exitCode).not.toBe(0)
    expect(`${stdout}\n${stderr}`).toContain('private-boundary-violation.fixture.ts:1')
    expect(`${stdout}\n${stderr}`).toContain('private-boundary-violation.fixture.ts:2')
  } finally {
    rmSync(fixture, { force: true })
  }
})
