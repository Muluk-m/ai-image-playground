import { existsSync } from 'node:fs'
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

/**
 * 反向：overlay 只许通过契约文件与宿主面取公开树的东西，不许深路径乱引。
 * 否则整棵公开源码树都是 overlay 的 API，公开树任何重构都可能悄悄打断收费版，
 * 而公开 CI 看不见（2026-09 的 TierBadge 事故就是这么来的）。
 *
 * 测试文件不算：overlay 的集成测试要拉起整个 BFF（app、task-runner、upstream……），那是测试基础设施
 * 而不是运行时面，断了在 overlay CI 里立刻可见，不需要这条规则替它把关。
 *
 * `private/` 不在时静默跳过——公开树必须能独立通过检查。
 */
const hostSurfaces: Record<string, true> = {
  'apps/admin/src/lib/private-host': true,
  'apps/admin/src/lib/private-overlay': true,
  'apps/bff/src/lib/private-host': true,
  'apps/bff/src/lib/private-overlay': true,
  'apps/web/src/lib/privateHost': true,
  'apps/web/src/lib/privateOverlay': true,
}
const publicReference = /['"]((?:\.\.\/)+)(apps\/(?:admin|bff|web)\/[^'"]*)['"]/g
const privateRoot = resolve(repositoryRoot, 'private')
const reverseViolations: string[] = []

if (existsSync(privateRoot)) {
  for await (const file of sourceGlob.scan({ cwd: privateRoot, onlyFiles: true })) {
    if (file.split('/').some((segment) => ignoredSegments.has(segment))) continue
    const path = `private/${file}`
    const source = await Bun.file(resolve(privateRoot, file)).text()
    const lines = source.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      for (const match of lines[index]!.matchAll(publicReference)) {
        const target = match[2]!.replace(/\.(?:tsx?|js)$/, '')
        if (!hostSurfaces[target]) {
          reverseViolations.push(`${path}:${index + 1} → ${target}`)
        }
      }
    }
  }
}

if (reverseViolations.length > 0) {
  console.error(
    `Overlay may only import the public tree through its contract and host surfaces (${Object.keys(hostSurfaces).join(', ')}):\n${reverseViolations.join('\n')}`,
  )
  process.exit(1)
}
