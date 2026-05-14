#!/usr/bin/env node
/**
 * 一键刷新灵感库：拉上游 cases.json、按需镜像新图到 R2、丢弃上游永久 404 的
 * item，写回 public/inspiration-manifest.json。幂等，可以频繁跑。
 *
 * 用法：
 *   pnpm --filter @image-playground/web refresh:inspiration
 *
 * 依赖：
 *   - wrangler 已登录，账号能写 r2://playload-cms
 *
 * 增量逻辑：
 *   - 已有 manifest 里 imageUrl 指向 cms-r2.deepclick.com 且 R2 key 跟上游
 *     basename 对得上 → 直接复用 URL，跳过 HEAD/下载/上传
 *   - 否则 HEAD 探测一下 R2，命中则只复用；缺则下载上游 + wrangler put
 *   - 上游图片 404（上游 repo 删除了文件）→ 该 item 从 manifest 排除
 *
 * 致谢：上游 freestylefly/awesome-gpt-image-2 (MIT)。
 */
import { writeFile, mkdir, unlink, rm } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'

const WEB_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..')
const MANIFEST_PATH = path.join(WEB_ROOT, 'public', 'inspiration-manifest.json')

const REPO_OWNER = 'freestylefly'
const REPO_NAME = 'awesome-gpt-image-2'
const REPO_BRANCH = 'main'
const CASES_URL = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${REPO_BRANCH}/data/cases.json`
const UPSTREAM_IMAGE_BASE = `https://cdn.jsdelivr.net/gh/${REPO_OWNER}/${REPO_NAME}@${REPO_BRANCH}/data`

const R2_BUCKET = 'playload-cms'
const R2_PREFIX = 'image-playground'
const PUBLIC_BASE = 'https://cms-r2.deepclick.com'
const THUMB_QUERY = '?w=320&q=85'

const DEFAULT_PARAMS = { size: 'auto', n: 1 }
const RECOMMENDED_MODEL = 'gpt-image-2'
const RECOMMENDED_PROVIDER = 'openai-compat'

const CONCURRENCY = 8

// 上游分类/风格/场景的中文映射；未命中保留英文原文
const CATEGORY_ZH = {
  'Architecture & Spaces': '建筑与空间',
  'Brand & Logos': '品牌与 Logo',
  'Characters & People': '人物与角色',
  'Charts & Infographics': '图表与信息图',
  'Documents & Publishing': '文档与排版',
  'History & Classical Themes': '历史与古典',
  'Illustration & Art': '插画与艺术',
  'Other Use Cases': '其他场景',
  'Photography & Realism': '摄影与写实',
  'Posters & Typography': '海报与字体',
  'Products & E-commerce': '产品与电商',
  'Scenes & Storytelling': '场景与叙事',
  'UI & Interfaces': 'UI 与界面',
}

const TAG_ZH = {
  '3D': '3D',
  Architecture: '建筑',
  Brand: '品牌',
  Character: '人物',
  Characters: '人物',
  Charts: '图表',
  Classical: '古典',
  Documents: '文档',
  History: '历史',
  Illustration: '插画',
  Infographic: '信息图',
  'Other Use Cases': '其他',
  Photography: '摄影',
  Poster: '海报',
  Product: '产品',
  Products: '产品',
  Realistic: '写实',
  Scenes: '场景',
  UI: 'UI',
  Commerce: '商业',
  Creative: '创意',
  Education: '教育',
  Fashion: '时尚',
  Food: '美食',
  Social: '社交',
  Story: '故事',
  Tech: '科技',
  Travel: '旅行',
}

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
}

const tr = (map, v) => map[v] ?? v
const trList = (map, vs) => Array.from(new Set(vs.map((v) => tr(map, v))))

function r2KeyFromUpstreamPath(upstreamImagePath) {
  return `${R2_PREFIX}/${path.basename(upstreamImagePath)}`
}

function publicUrl(key, withResize) {
  return `${PUBLIC_BASE}/${key}${withResize ? THUMB_QUERY : ''}`
}

function existingR2Key(item) {
  if (typeof item?.imageUrl !== 'string' || !item.imageUrl.startsWith(`${PUBLIC_BASE}/`)) return null
  try {
    return new URL(item.imageUrl).pathname.replace(/^\/+/, '')
  } catch {
    return null
  }
}

function mimeFor(filename) {
  return MIME_BY_EXT[path.extname(filename).toLowerCase()] ?? 'application/octet-stream'
}

async function run(cmd, args) {
  return await new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    p.stdout.on('data', () => {})
    p.stderr.on('data', (chunk) => { stderr += chunk })
    p.on('error', reject)
    p.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} exit ${code}: ${stderr.slice(0, 300)}`))
    })
  })
}

async function r2HasObject(key) {
  // HEAD 在 public CDN 上比 wrangler r2 object get 快得多。
  // 只 404 视为「不存在」；401/403/5xx 等抛出，避免静默重传。
  const res = await fetch(`${PUBLIC_BASE}/${key}`, { method: 'HEAD' })
  if (res.status === 200) return true
  if (res.status === 404) return false
  throw new Error(`HEAD ${PUBLIC_BASE}/${key} returned ${res.status}`)
}

async function downloadAndUpload(upstreamUrl, key, tmpDir) {
  const res = await fetch(upstreamUrl)
  if (res.status === 404) return { ok: false, reason: 'upstream-404' }
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${upstreamUrl}`)
  const bytes = Buffer.from(await res.arrayBuffer())
  const local = path.join(tmpDir, path.basename(key))
  await writeFile(local, bytes)
  try {
    await run('wrangler', [
      'r2', 'object', 'put',
      `${R2_BUCKET}/${key}`,
      '--file', local,
      '--content-type', mimeFor(local),
      '--remote',
    ])
  } finally {
    await unlink(local).catch(() => {})
  }
  return { ok: true, bytes: bytes.length }
}

function buildItem(raw, key) {
  const rawTags = [
    ...(Array.isArray(raw.styles) ? raw.styles : []),
    ...(Array.isArray(raw.scenes) ? raw.scenes : []),
  ]
  const tags = trList(TAG_ZH, rawTags)
  const category = typeof raw.category === 'string' && raw.category ? raw.category : 'Other Use Cases'
  const item = {
    id: `awesome-${raw.id}`,
    title: raw.title,
    prompt: raw.prompt,
    thumbnailUrl: publicUrl(key, true),
    imageUrl: publicUrl(key, false),
    params: { ...DEFAULT_PARAMS },
    recommendedModel: RECOMMENDED_MODEL,
    recommendedProvider: RECOMMENDED_PROVIDER,
    category: tr(CATEGORY_ZH, category),
  }
  if (tags.length) item.tags = tags
  if (typeof raw.sourceLabel === 'string' && raw.sourceLabel) item.author = raw.sourceLabel
  if (typeof raw.sourceUrl === 'string' && raw.sourceUrl) item.sourceUrl = raw.sourceUrl
  return item
}

function isValidCase(raw) {
  return raw
    && typeof raw.id === 'number'
    && typeof raw.prompt === 'string'
    && typeof raw.title === 'string'
    && typeof raw.image === 'string'
}

/**
 * 单条 case 的处理：决定复用 / 镜像 / 丢弃，返回最终 item（null = 丢）。
 */
async function processCase(raw, existingById, tmpDir, stats) {
  if (!isValidCase(raw)) {
    stats.invalid++
    return null
  }
  const id = `awesome-${raw.id}`
  const key = r2KeyFromUpstreamPath(raw.image)
  const existing = existingById.get(id)

  // 1. 已镜像 + key 没变 → 完全跳过远端调用，只更新元信息（title/prompt 等）
  if (existing && existingR2Key(existing) === key) {
    stats.reused++
    return buildItem(raw, key)
  }

  // 2. HEAD 探测 R2（处理 manifest 丢了但 R2 还在的情况，或者刚换文件名）
  if (await r2HasObject(key)) {
    stats.adopted++
    return buildItem(raw, key)
  }

  // 3. 真的需要镜像
  const upstreamUrl = `${UPSTREAM_IMAGE_BASE}${raw.image}`
  const result = await downloadAndUpload(upstreamUrl, key, tmpDir)
  if (!result.ok) {
    stats.dropped++
    console.warn(`  ⊘ ${id} ${raw.image}：上游 404，丢弃`)
    return null
  }
  stats.mirrored++
  console.log(`  + ${id} ${key} 上传 ${(result.bytes / 1024).toFixed(0)}KB`)
  return buildItem(raw, key)
}

async function readExistingManifest() {
  if (!existsSync(MANIFEST_PATH)) return { items: [] }
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
  } catch (err) {
    console.warn(`⚠ 现有 manifest 损坏，按全新刷新处理：${err.message}`)
    return { items: [] }
  }
}

async function main() {
  console.log(`↓ 拉取 ${CASES_URL}`)
  const casesRes = await fetch(CASES_URL)
  if (!casesRes.ok) throw new Error(`HTTP ${casesRes.status} 拉取 cases.json 失败`)
  const upstream = await casesRes.json()
  if (!upstream || !Array.isArray(upstream.cases)) {
    throw new Error('cases.json 结构异常（缺 cases 数组）')
  }

  const existing = await readExistingManifest()
  const existingById = new Map((existing.items ?? []).map((i) => [i.id, i]))

  const tmpDir = path.join(os.tmpdir(), `inspiration-refresh-${Date.now()}`)
  await mkdir(tmpDir, { recursive: true })

  const total = upstream.cases.length
  const out = new Array(total)
  const stats = { invalid: 0, reused: 0, adopted: 0, mirrored: 0, dropped: 0, failed: 0 }
  let cursor = 0

  console.log(`↻ 处理 ${total} 条上游 case，并发 ${CONCURRENCY}`)
  try {
    async function worker() {
      while (cursor < total) {
        const i = cursor++
        const raw = upstream.cases[i]
        try {
          out[i] = await processCase(raw, existingById, tmpDir, stats)
        } catch (err) {
          stats.failed++
          out[i] = null
          console.error(`  ✗ case ${raw?.id ?? i + 1}：${err.message}`)
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }

  const items = out.filter((x) => x !== null)
  const categories = Array.isArray(upstream.categories) ? trList(CATEGORY_ZH, upstream.categories) : undefined
  const manifest = {
    version: 1,
    updatedAt: new Date().toISOString(),
    ...(categories ? { categories } : {}),
    items,
  }
  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  console.log('\n✓ 刷新完成')
  console.log(`  manifest：${path.relative(WEB_ROOT, MANIFEST_PATH)}（${items.length} 条）`)
  console.log(`  reused=${stats.reused}  adopted=${stats.adopted}  mirrored=${stats.mirrored}  dropped=${stats.dropped}  invalid=${stats.invalid}  failed=${stats.failed}`)
  if (stats.failed) process.exitCode = 2
}

main().catch((err) => {
  console.error('✗ 刷新失败：', err)
  process.exit(1)
})
