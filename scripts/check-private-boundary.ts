import { relative, resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dir, '..')
const auditedSeams = new Set([
  'apps/admin/src/lib/private-overlay.tsx',
  'apps/bff/src/lib/private-overlay.ts',
  'apps/web/src/lib/privateOverlay.tsx',
])
const ignoredSegments = new Set(['__tests__', 'dist', 'generated', 'node_modules', '.turbo'])
const privateReferencePatterns = [
  /\bfrom\s*['"][^'"]*private\//,
  /\bimport\s*['"][^'"]*private\//,
  /\bimport\s*\(\s*['"][^'"]*private\//,
  /\bimport\.meta\.glob\s*\(\s*['"][^'"]*private\//,
  /\bnew URL\s*\(\s*['"][^'"]*private\//,
  /\brequire\s*\(\s*['"][^'"]*private\//,
  /\bdeclare\s+module\s*['"][^'"]*private\//,
  /['"][^'"]*(?:\.\.\/){2,}\*\/apps\/(?:admin|bff|web)\//,
]
const sourceGlob = new Bun.Glob('**/*.{ts,tsx,js,mjs,cjs}')
const violations: string[] = []

for (const root of ['apps', 'packages']) {
  for await (const file of sourceGlob.scan({
    cwd: resolve(repositoryRoot, root),
    onlyFiles: true,
  })) {
    const path = `${root}/${file}`
    if (auditedSeams.has(path) || path.split('/').some((segment) => ignoredSegments.has(segment))) {
      continue
    }
    const source = await Bun.file(resolve(repositoryRoot, path)).text()
    const lines = source.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      if (privateReferencePatterns.some((pattern) => pattern.test(lines[index]!))) {
        violations.push(`${path}:${index + 1}`)
      }
    }
  }
}

if (violations.length > 0) {
  console.error(
    `Private-tree references are only allowed at the three audited overlay seams:\n${violations.join('\n')}`,
  )
  process.exit(1)
}
