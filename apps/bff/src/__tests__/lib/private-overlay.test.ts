import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadPrivateBffOverlay } from '../../lib/private-overlay'

const repositoryRoot = resolve(import.meta.dir, '../../../../..')

async function lintBoundaryViolation(
  source: string,
): Promise<{ exitCode: number; output: string }> {
  const fixtureDirectory = mkdtempSync(
    join(repositoryRoot, 'apps/bff/src/__tests__/.private-boundary-'),
  )
  const fixture = join(fixtureDirectory, 'violation.ts')
  writeFileSync(fixture, source)
  try {
    const child = Bun.spawn([join(repositoryRoot, 'node_modules/.bin/biome'), 'lint', fixture], {
      cwd: repositoryRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { exitCode, output: `${stdout}\n${stderr}` }
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true })
  }
}

describe('private overlay boundary', () => {
  it('returns the useful empty overlay when the private entry is absent', async () => {
    const outputDirectory = mkdtempSync(join(tmpdir(), 'image-playground-public-build-'))
    try {
      const build = await Bun.build({
        entrypoints: [join(repositoryRoot, 'apps/bff/src/lib/private-overlay.ts')],
        outdir: outputDirectory,
        target: 'bun',
      })
      expect(build.success).toBe(true)
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true })
    }

    const overlay = await loadPrivateBffOverlay(
      pathToFileURL(join(outputDirectory, 'missing-private-entry.ts')),
    )
    expect(overlay.present).toBe(false)
    const response = await overlay.routes.handle(new Request('http://localhost/private-route'))
    expect(response.status).toBe(404)
  })

  it('makes Biome reject static and dynamic private-tree imports', async () => {
    const staticImport = await lintBoundaryViolation("import '../../../../private/example.ts'\n")
    const dynamicImport = await lintBoundaryViolation(
      "await import('../../../../private/example.ts')\n",
    )

    expect(staticImport.exitCode).not.toBe(0)
    expect(staticImport.output).toContain('lint/style/noRestrictedImports')
    expect(dynamicImport.exitCode).not.toBe(0)
    expect(dynamicImport.output).toContain('lint/style/noRestrictedImports')
  })
})
