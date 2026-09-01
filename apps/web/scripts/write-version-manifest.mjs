// 为「前端独立托管」形态在构建期生成 version.json：已打开的页面靠轮询它发现新部署。
//
// 与 runtime-config.json 同一层（build:static-host），不放在 pages-deploy.sh 里——
// 否则只有走那一个部署脚本的产物才带清单，直接 build 出来的静态站永远收不到提示。
//
// 容器形态跑的是 `pnpm build`，不产出清单；nginx 对 /version.json 显式 404，前端静默忽略。
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function parseBoolean(name, raw) {
  if (raw === undefined || raw === '') return false
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw new Error(`${name} must be true or false`)
}

function shortSha(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}

/**
 * 版本号只需要「每次构建都不同」，内容不构成协议。带上 sha 是为了从线上版本号能倒查
 * 到提交；私有 overlay 是独立检出，它自己动了也要换号。
 */
export function buildVersionManifest(env, repoRoot, now = new Date()) {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
  const shas = [shortSha(repoRoot), shortSha(join(repoRoot, 'private'))].filter(Boolean)
  const version = shas.length > 0 ? `${shas.join('+')}-${stamp}` : stamp
  return { version, notify: parseBoolean('NOTIFY_UPDATE', env.NOTIFY_UPDATE) }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const repoRoot = join(scriptDir, '..', '..', '..')
  const manifest = buildVersionManifest(process.env, repoRoot)
  const outDir = process.env.RUNTIME_CONFIG_DIR ?? join(scriptDir, '..', 'dist')
  const outFile = join(outDir, 'version.json')

  await mkdir(outDir, { recursive: true })
  await writeFile(outFile, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(
    `✓ 已写 version manifest → ${outFile}（version=${manifest.version}, notify=${manifest.notify}）`,
  )
}
