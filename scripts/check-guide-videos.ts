/**
 * 指南和官网 public 不再收演示视频。成片在 cms-r2，地址只写在
 * apps/web/src/features/guide/content/media.ts。封面 webp 仍留在仓库里。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'

const repo = new URL('..', import.meta.url).pathname
const videoExt = new Set(['.mp4', '.webm', '.mov'])
const trees = ['apps/web/public/guide-assets', 'apps/website/public']
const problems: string[] = []

function walk(dir: string): void {
  let entries: ReturnType<typeof readdirSync>
  try {
    entries = readdirSync(join(repo, dir), { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    const rel = join(dir, entry.name)
    if (entry.isDirectory()) walk(rel)
    else if (videoExt.has(extname(entry.name).toLowerCase()))
      problems.push(`${rel}: 演示视频不能提交。用 cms CLI 上传到 cms-r2，再更新映射表`)
  }
}

for (const tree of trees) walk(tree)

const localVideo = /guide-assets\/[^"'`\s]+\.(?:mp4|webm|mov)\b/g
const cdnVideo = /https:\/\/cms-r2\.deepclick\.com\/[^"'`\s]+\.(?:mp4|webm|mov)\b/g
const allowCdn = new Set(['apps/web/src/features/guide/content/media.ts'])

const glob = new Bun.Glob('apps/**/*.{ts,tsx,html,mjs}')
for await (const file of glob.scan({ cwd: repo })) {
  if (file.includes('/dist/') || file.includes('/node_modules/') || file.includes('/__tests__/'))
    continue
  const text = readFileSync(join(repo, file), 'utf8')
  localVideo.lastIndex = 0
  if (localVideo.test(text)) problems.push(`${file}: 不要写本地 guide-assets 视频路径，改走映射表`)
  if (allowCdn.has(file)) continue
  cdnVideo.lastIndex = 0
  if (cdnVideo.test(text))
    problems.push(`${file}: CDN 视频地址只维护在 guide content 的 media 模块`)
}

if (problems.length > 0) {
  for (const line of problems) console.error(line)
  process.exitCode = 1
}
