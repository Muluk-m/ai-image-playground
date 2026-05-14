#!/usr/bin/env node
/**
 * 一键刷新灵感库：
 *   - 上游 freestylefly/awesome-gpt-image-2 (cases.json) → gpt 提示词
 *   - 上游 YouMind-OpenLab/awesome-nano-banana-pro-prompts (README_zh.md) → banana 提示词
 *   - 两路图片按需镜像到 r2://playload-cms/{image-playground,image-playground-banana}/
 *   - 上游永久 404 的 item 自动从 manifest 排除
 *   - 写回 public/inspiration-manifest.json，幂等可频繁跑
 *
 * 用法：
 *   pnpm --filter @image-playground/web refresh:inspiration
 *
 * 依赖：wrangler 已登录，账号能写 r2://playload-cms
 *
 * 致谢：
 *   - freestylefly/awesome-gpt-image-2 (MIT)
 *   - YouMind-OpenLab/awesome-nano-banana-pro-prompts (CC BY 4.0)
 */
import { writeFile, mkdir, unlink, rm } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'

const WEB_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..')
const MANIFEST_PATH = path.join(WEB_ROOT, 'public', 'inspiration-manifest.json')

const R2_BUCKET = 'playload-cms'
const PUBLIC_BASE = 'https://cms-r2.deepclick.com'
const THUMB_QUERY = '?w=320&q=85'

const CONCURRENCY = 8

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
}

// ─────────── 通用工具 ───────────

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

/**
 * 处理一条 raw item：决定复用 / 镜像 / 丢弃，返回最终 inspiration item（null = 丢）。
 * raw 必须提供 { id, upstreamImageUrl, r2Key, buildItem(key) }。
 */
async function processOne(raw, existingById, tmpDir, stats) {
  const existing = existingById.get(raw.id)
  if (existing && existingR2Key(existing) === raw.r2Key) {
    stats.reused++
    return raw.buildItem(raw.r2Key)
  }
  if (await r2HasObject(raw.r2Key)) {
    stats.adopted++
    return raw.buildItem(raw.r2Key)
  }
  const result = await downloadAndUpload(raw.upstreamImageUrl, raw.r2Key, tmpDir)
  if (!result.ok) {
    stats.dropped++
    console.warn(`  ⊘ ${raw.id} ${raw.upstreamImageUrl}：上游 404，丢弃`)
    return null
  }
  stats.mirrored++
  console.log(`  + ${raw.id} ${raw.r2Key} 上传 ${(result.bytes / 1024).toFixed(0)}KB`)
  return raw.buildItem(raw.r2Key)
}

async function pMap(items, concurrency, worker) {
  const out = new Array(items.length)
  let cursor = 0
  async function loop() {
    while (cursor < items.length) {
      const i = cursor++
      out[i] = await worker(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => loop()))
  return out
}

// ─────────── Source: GPT (freestylefly/awesome-gpt-image-2) ───────────

const GPT_REPO = 'freestylefly/awesome-gpt-image-2'
const GPT_BRANCH = 'main'
const GPT_CASES_URL = `https://raw.githubusercontent.com/${GPT_REPO}/${GPT_BRANCH}/data/cases.json`
const GPT_IMAGE_BASE = `https://cdn.jsdelivr.net/gh/${GPT_REPO}@${GPT_BRANCH}/data`
const GPT_R2_PREFIX = 'image-playground'

const GPT_CATEGORY_ZH = {
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

const GPT_TAG_ZH = {
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

const tr = (map, v) => map[v] ?? v
const trList = (map, vs) => Array.from(new Set(vs.map((v) => tr(map, v))))

async function loadGptSource() {
  console.log(`↓ ${GPT_CASES_URL}`)
  const res = await fetch(GPT_CASES_URL)
  if (!res.ok) throw new Error(`HTTP ${res.status} 拉取 GPT cases.json 失败`)
  const upstream = await res.json()
  if (!upstream || !Array.isArray(upstream.cases)) {
    throw new Error('GPT cases.json 结构异常（缺 cases 数组）')
  }
  const raws = []
  let invalid = 0
  for (const raw of upstream.cases) {
    if (!isValidGptCase(raw)) {
      invalid++
      continue
    }
    raws.push({
      id: `awesome-${raw.id}`,
      upstreamImageUrl: `${GPT_IMAGE_BASE}${raw.image}`,
      r2Key: `${GPT_R2_PREFIX}/${path.basename(raw.image)}`,
      buildItem: (key) => buildGptItem(raw, key),
    })
  }
  return {
    name: 'gpt',
    raws,
    invalid,
    categories: Array.isArray(upstream.categories)
      ? trList(GPT_CATEGORY_ZH, upstream.categories)
      : undefined,
  }
}

function isValidGptCase(raw) {
  return raw
    && typeof raw.id === 'number'
    && typeof raw.prompt === 'string'
    && typeof raw.title === 'string'
    && typeof raw.image === 'string'
}

function buildGptItem(raw, key) {
  const rawTags = [
    ...(Array.isArray(raw.styles) ? raw.styles : []),
    ...(Array.isArray(raw.scenes) ? raw.scenes : []),
  ]
  const tags = trList(GPT_TAG_ZH, rawTags)
  const category = typeof raw.category === 'string' && raw.category ? raw.category : 'Other Use Cases'
  const item = {
    id: `awesome-${raw.id}`,
    title: raw.title,
    prompt: raw.prompt,
    thumbnailUrl: publicUrl(key, true),
    imageUrl: publicUrl(key, false),
    params: { size: 'auto', n: 1 },
    recommendedModel: 'gpt-image-2',
    recommendedProvider: 'openai-compat',
    category: tr(GPT_CATEGORY_ZH, category),
  }
  if (tags.length) item.tags = tags
  if (typeof raw.sourceLabel === 'string' && raw.sourceLabel) item.author = raw.sourceLabel
  if (typeof raw.sourceUrl === 'string' && raw.sourceUrl) item.sourceUrl = raw.sourceUrl
  return item
}

// ─────────── Source: Banana (YouMind-OpenLab/awesome-nano-banana-pro-prompts) ───────────

const BANANA_REPO = 'YouMind-OpenLab/awesome-nano-banana-pro-prompts'
const BANANA_BRANCH = 'main'
const BANANA_README_URL = `https://raw.githubusercontent.com/${BANANA_REPO}/${BANANA_BRANCH}/README_zh.md`
const BANANA_R2_PREFIX = 'image-playground-banana'
const BANANA_RECOMMENDED_MODEL = 'gemini-3.1-flash-image'
const BANANA_RECOMMENDED_PROVIDER = 'gemini'
const BANANA_FEATURED_CATEGORY = '精选'

async function loadBananaSource() {
  console.log(`↓ ${BANANA_README_URL}`)
  const res = await fetch(BANANA_README_URL)
  if (!res.ok) throw new Error(`HTTP ${res.status} 拉取 banana README 失败`)
  const md = await res.text()
  const parsed = parseBananaMarkdown(md)
  if (!parsed.length) throw new Error('banana README 解析后 0 条，疑似格式变了')

  // 同一 cms id 同时出现在 featured 和 all-prompts 时（理论上不会，但兜底），
  // all-prompts 版本带 category，更优；保留它。
  const byId = new Map()
  for (const raw of parsed) {
    const existing = byId.get(raw.id)
    if (!existing || (raw.section === 'all' && existing.section === 'featured')) {
      byId.set(raw.id, raw)
    }
  }

  const raws = []
  for (const raw of byId.values()) {
    raws.push({
      id: `banana-${raw.id}`,
      upstreamImageUrl: raw.images[0],
      r2Key: `${BANANA_R2_PREFIX}/${raw.id}${path.extname(new URL(raw.images[0]).pathname) || '.jpg'}`,
      buildItem: (key) => buildBananaItem(raw, key),
    })
  }
  return { name: 'banana', raws, invalid: 0, categories: undefined }
}

/**
 * 把 README_zh.md 解析成 { id, title, category, section, description, prompt,
 * images[], author, sourceUrl } 数组。
 *
 * 切片策略：先找 `## 🔥 精选提示词` / `## 📋 所有提示词` 两段，再在段内按
 * `^### No\. \d+: ` 切块。featured 段 title 不含分类前缀；all-prompts 段
 * title 形如 `<分类> - <名称>`。
 */
function parseBananaMarkdown(md) {
  const featuredHeader = md.indexOf('\n## 🔥 ')
  const allHeader = md.indexOf('\n## 📋 ')
  if (featuredHeader < 0 || allHeader < 0) {
    throw new Error('banana README 缺少「🔥 精选提示词」或「📋 所有提示词」章节')
  }
  // all-prompts 章节结束在下一个 `^## ` 处（贡献指南等）
  const allEnd = md.indexOf('\n## ', allHeader + 1)

  const featuredBlock = md.slice(featuredHeader, allHeader)
  const allBlock = md.slice(allHeader, allEnd > 0 ? allEnd : md.length)

  const items = []
  for (const { text, section } of [
    { text: featuredBlock, section: 'featured' },
    { text: allBlock, section: 'all' },
  ]) {
    const blocks = splitByCaseHeader(text)
    for (const block of blocks) {
      const item = parseBananaBlock(block, section)
      if (item) items.push(item)
    }
  }
  return items
}

function splitByCaseHeader(text) {
  // 按 `^### No\. N: ` 切片；返回去除标题行前缀但保留标题文本的块
  const parts = text.split(/^### No\. \d+: /m)
  return parts.slice(1)
}

function parseBananaBlock(block, section) {
  const titleEnd = block.indexOf('\n')
  if (titleEnd < 0) return null
  const titleRaw = block.slice(0, titleEnd).trim()

  let category = section === 'featured' ? BANANA_FEATURED_CATEGORY : null
  let title = titleRaw
  if (section === 'all') {
    const sepIdx = titleRaw.indexOf(' - ')
    if (sepIdx >= 0) {
      category = titleRaw.slice(0, sepIdx).trim()
      title = titleRaw.slice(sepIdx + 3).trim()
    } else {
      category = '其他'
    }
  }

  const body = block.slice(titleEnd + 1)
  const description = sliceSection(body, /^#### 📖 [^\n]*$/m, /^#### /m).trim() || null
  const promptBody = sliceSection(body, /^#### 📝 [^\n]*$/m, /^#### /m)
  const promptMatch = /```[a-zA-Z]*\n([\s\S]*?)\n```/.exec(promptBody)
  const prompt = promptMatch ? promptMatch[1].trim() : null
  const imgBody = sliceSection(body, /^#### 🖼️ [^\n]*$/m, /^#### /m)
  const images = Array.from(imgBody.matchAll(/<img\s+[^>]*\bsrc="([^"]+)"/g)).map((m) => m[1])
  const detailBody = sliceSection(body, /^#### 📌 [^\n]*$/m, /^---\s*$/m)
  const author = firstCapture(detailBody, /\*\*作者:?\*\*\s*\[([^\]]+)\]/)
  const sourceUrl = firstCapture(detailBody, /\*\*来源:?\*\*\s*\[[^\]]+\]\(([^)]+)\)/)
  const cmsId = firstCapture(detailBody, /\?id=(\d+)/)

  if (!cmsId || !prompt || !title || images.length === 0) return null
  return {
    id: cmsId,
    title,
    category,
    section,
    description,
    prompt,
    images,
    author,
    sourceUrl,
  }
}

function sliceSection(text, startRe, endRe) {
  const start = startRe.exec(text)
  if (!start) return ''
  const offset = start.index + start[0].length
  const rest = text.slice(offset)
  const end = endRe.exec(rest)
  return end ? rest.slice(0, end.index) : rest
}

function firstCapture(text, re) {
  const m = re.exec(text)
  return m ? m[1] : null
}

function buildBananaItem(raw, key) {
  const item = {
    id: `banana-${raw.id}`,
    title: raw.title,
    prompt: raw.prompt,
    thumbnailUrl: publicUrl(key, true),
    imageUrl: publicUrl(key, false),
    params: { size: 'auto', n: 1 },
    recommendedModel: BANANA_RECOMMENDED_MODEL,
    recommendedProvider: BANANA_RECOMMENDED_PROVIDER,
    category: raw.category || '其他',
  }
  if (raw.description) item.description = raw.description
  if (raw.author) item.author = raw.author
  if (raw.sourceUrl) item.sourceUrl = raw.sourceUrl
  return item
}

// ─────────── Main pipeline ───────────

function readExistingManifest() {
  if (!existsSync(MANIFEST_PATH)) return { items: [] }
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
  } catch (err) {
    console.warn(`⚠ 现有 manifest 损坏，按全新刷新处理：${err.message}`)
    return { items: [] }
  }
}

async function main() {
  const sources = [await loadGptSource(), await loadBananaSource()]
  const existing = readExistingManifest()
  const existingById = new Map((existing.items ?? []).map((i) => [i.id, i]))

  const tmpDir = path.join(os.tmpdir(), `inspiration-refresh-${Date.now()}`)
  await mkdir(tmpDir, { recursive: true })

  let allItems = []
  const categories = new Set()

  try {
    for (const source of sources) {
      const stats = { reused: 0, adopted: 0, mirrored: 0, dropped: 0, failed: 0 }
      console.log(`\n↻ 处理 ${source.name}：${source.raws.length} 条，并发 ${CONCURRENCY}`)
      const items = await pMap(source.raws, CONCURRENCY, async (raw) => {
        try {
          return await processOne(raw, existingById, tmpDir, stats)
        } catch (err) {
          stats.failed++
          console.error(`  ✗ ${raw.id}：${err.message}`)
          // 失败时保留既有 manifest 条目，避免一次瞬时网络/限流就丢条目
          return existingById.get(raw.id) ?? null
        }
      })
      const valid = items.filter((x) => x !== null)
      allItems = allItems.concat(valid)
      if (source.categories) source.categories.forEach((c) => categories.add(c))
      console.log(
        `  ${source.name}: total=${valid.length}  reused=${stats.reused}  adopted=${stats.adopted}  mirrored=${stats.mirrored}  dropped=${stats.dropped}  invalid=${source.invalid}  failed=${stats.failed}`,
      )
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }

  // 从 items 派生剩余 categories（banana 没有外部 categories 列表）
  for (const item of allItems) {
    if (item.category) categories.add(item.category)
  }

  const manifest = {
    version: 1,
    updatedAt: new Date().toISOString(),
    categories: Array.from(categories).sort((a, b) => a.localeCompare(b, 'zh-CN')),
    items: allItems,
  }
  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  console.log(`\n✓ 刷新完成`)
  console.log(`  manifest：${path.relative(WEB_ROOT, MANIFEST_PATH)}（${allItems.length} 条 / ${manifest.categories.length} 分类）`)
}

main().catch((err) => {
  console.error('✗ 刷新失败：', err)
  process.exit(1)
})
