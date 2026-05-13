#!/usr/bin/env node
/**
 * 把灵感库 manifest 里指向 jsdelivr / GitHub raw 的图片镜像到 Cloudflare R2，
 * 改写 thumbnailUrl / imageUrl 指向 https://cms-r2.deepclick.com/image-playground/<file>。
 *
 * 用法（仓库根目录）：
 *   pnpm --filter @image-playground/web mirror:r2
 *
 * 依赖：本机已 wrangler login，账号能写 playload-cms 桶。
 *
 * 行为：
 *   - 读 apps/web/public/inspiration-manifest.json
 *   - 对每条 item，按 imageUrl 文件名作为 R2 key（image-playground/<basename>）
 *   - HEAD 探测 R2 是否已有该 key；缺则下载源图、wrangler r2 object put 上传
 *   - 改写 manifest：thumbnailUrl 加 ?w=320&q=85，imageUrl 原图
 *   - 写回 inspiration-manifest.json
 */
import { writeFile, mkdir, readFile, stat, unlink } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..')
const MANIFEST_PATH = path.join(ROOT, 'public', 'inspiration-manifest.json')

const R2_BUCKET = 'playload-cms'
const R2_PREFIX = 'image-playground'
const PUBLIC_BASE = 'https://cms-r2.deepclick.com'
const THUMB_QUERY = '?w=320&q=85'
const CONCURRENCY = 6

const TMP_DIR = path.join(os.tmpdir(), `inspiration-mirror-${Date.now()}`)

function r2Key(srcUrl) {
  // srcUrl 形如 https://cdn.jsdelivr.net/gh/.../data/images/case427.jpg
  // 取 basename 作为 R2 key 后缀
  const u = new URL(srcUrl)
  const base = path.basename(u.pathname)
  return `${R2_PREFIX}/${base}`
}

function publicUrl(key, withResize) {
  return `${PUBLIC_BASE}/${key}${withResize ? THUMB_QUERY : ''}`
}

async function run(cmd, args, opts = {}) {
  return await new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (chunk) => { stdout += chunk })
    p.stderr.on('data', (chunk) => { stderr += chunk })
    p.on('error', reject)
    p.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${cmd} exit ${code}: ${stderr.slice(0, 300) || stdout.slice(0, 300)}`))
    })
  })
}

async function r2ObjectExists(key) {
  // 用 public CDN 做 HEAD 探测，比 wrangler r2 object get 快得多（不下载 body）。
  // resize query 不带 → 命中原图缓存层
  const url = `${PUBLIC_BASE}/${key}`
  try {
    const res = await fetch(url, { method: 'HEAD' })
    if (res.status === 200) return true
    if (res.status === 404) return false
    throw new Error(`HEAD ${url} returned ${res.status}`)
  } catch (err) {
    // 网络异常视为「未确认存在」→ 当作不存在重传一次（put 本身幂等）
    void err
    return false
  }
}

async function downloadToFile(url, dest) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  await writeFile(dest, buf)
  return buf.length
}

async function uploadToR2(localPath, key, contentType) {
  await run('wrangler', [
    'r2', 'object', 'put',
    `${R2_BUCKET}/${key}`,
    '--file', localPath,
    '--content-type', contentType,
    '--remote',
  ])
}

function guessMime(filename) {
  const ext = path.extname(filename).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  return 'image/jpeg'
}

async function mirrorOne(item, idx, total) {
  const src = item.imageUrl || item.thumbnailUrl
  if (!src) return { item, skipped: 'no-url' }
  const key = r2Key(src)
  const filename = path.basename(key)
  const mime = guessMime(filename)

  let status = 'cached'
  const exists = await r2ObjectExists(key)
  if (!exists) {
    const local = path.join(TMP_DIR, filename)
    const bytes = await downloadToFile(src, local)
    await uploadToR2(local, key, mime)
    await unlink(local).catch(() => {})
    status = `uploaded ${(bytes / 1024).toFixed(0)}KB`
  }

  const updated = {
    ...item,
    thumbnailUrl: publicUrl(key, true),
    imageUrl: publicUrl(key, false),
  }
  console.log(`  [${idx + 1}/${total}] ${item.id} → ${key} (${status})`)
  return { item: updated, src, key }
}

async function main() {
  const raw = await readFile(MANIFEST_PATH, 'utf8')
  const manifest = JSON.parse(raw)
  const total = manifest.items.length
  console.log(`↻ 镜像 ${total} 张图到 r2://${R2_BUCKET}/${R2_PREFIX}/`)
  await mkdir(TMP_DIR, { recursive: true })

  const out = new Array(total)
  let cursor = 0
  let failed = 0
  async function worker() {
    while (cursor < total) {
      const i = cursor++
      try {
        const r = await mirrorOne(manifest.items[i], i, total)
        out[i] = r.item
      } catch (err) {
        failed++
        console.error(`  [${i + 1}/${total}] ✗ ${manifest.items[i].id}: ${err.message}`)
        out[i] = manifest.items[i]
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))

  manifest.items = out
  manifest.updatedAt = new Date().toISOString()
  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  console.log(`\n✓ 完成${failed ? `（${failed} 条失败保留原 URL，请人工 retry）` : ''}`)
  console.log(`  manifest 已更新：${path.relative(ROOT, MANIFEST_PATH)}`)
}

main().catch((err) => {
  console.error('✗ 迁移失败：', err)
  process.exit(1)
})
