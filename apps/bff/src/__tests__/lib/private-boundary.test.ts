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
      'Private-tree imports are only allowed at the audited BFF overlay seam.',
    )
  } finally {
    rmSync(fixture, { force: true })
  }
})
