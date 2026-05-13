#!/usr/bin/env node
/**
 * 一次性导入 freestylefly/awesome-gpt-image-2 的 cases.json 为本仓库的灵感 manifest。
 *
 * 用法（仓库根目录）：
 *   pnpm import:inspiration
 *
 * 行为：
 *   - 拉取上游 `data/cases.json`（GitHub raw），无需 token
 *   - 转换成 InspirationManifest（id 前缀 `awesome-`、thumbnailUrl 指向 raw.githubusercontent）
 *   - 覆写 `public/inspiration-manifest.json`
 *   - 上游 MIT，转载需保留致谢（见 README）
 */
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const REPO_OWNER = 'freestylefly'
const REPO_NAME = 'awesome-gpt-image-2'
const REPO_BRANCH = 'main'
const SOURCE_URL = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${REPO_BRANCH}/data/cases.json`
const IMAGE_BASE = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${REPO_BRANCH}/data`

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..')
const OUTPUT = path.join(ROOT, 'public', 'inspiration-manifest.json')

const DEFAULT_PARAMS = { size: 'auto', n: 1 }
const RECOMMENDED_MODEL = 'gpt-image-2'
const RECOMMENDED_PROVIDER = 'openai-compat'

function transformCase(raw) {
  if (!raw || typeof raw.id !== 'number' || typeof raw.prompt !== 'string' || typeof raw.title !== 'string' || typeof raw.image !== 'string') {
    return null
  }
  const tags = [...(Array.isArray(raw.styles) ? raw.styles : []), ...(Array.isArray(raw.scenes) ? raw.scenes : [])]
  const item = {
    id: `awesome-${raw.id}`,
    title: raw.title,
    prompt: raw.prompt,
    thumbnailUrl: `${IMAGE_BASE}${raw.image}`,
    params: { ...DEFAULT_PARAMS },
    recommendedModel: RECOMMENDED_MODEL,
    recommendedProvider: RECOMMENDED_PROVIDER,
    category: typeof raw.category === 'string' && raw.category ? raw.category : 'Other Use Cases',
  }
  if (tags.length) item.tags = Array.from(new Set(tags))
  if (typeof raw.sourceLabel === 'string' && raw.sourceLabel) item.author = raw.sourceLabel
  if (typeof raw.sourceUrl === 'string' && raw.sourceUrl) item.sourceUrl = raw.sourceUrl
  return item
}

async function main() {
  console.log(`↓ 拉取 ${SOURCE_URL}`)
  const response = await fetch(SOURCE_URL)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} 拉取上游 cases.json 失败`)
  }
  const upstream = await response.json()
  if (!upstream || !Array.isArray(upstream.cases)) {
    throw new Error('上游 cases.json 结构不符合预期（缺 cases 数组）')
  }

  const items = upstream.cases.map(transformCase).filter(Boolean)
  const skipped = upstream.cases.length - items.length

  // 按 id 倒序（上游就是从最新 id 开始往下排）；保持上游顺序
  const manifest = {
    version: 1,
    updatedAt: new Date().toISOString(),
    categories: Array.isArray(upstream.categories) ? upstream.categories : undefined,
    items,
  }

  await writeFile(OUTPUT, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  console.log(`✓ 已写入 ${path.relative(ROOT, OUTPUT)}`)
  console.log(`  · ${items.length} 条 prompt`)
  if (skipped > 0) console.log(`  · 跳过 ${skipped} 条字段不完整`)
  console.log('  · 致谢上游：freestylefly/awesome-gpt-image-2 (MIT)')
}

main().catch((err) => {
  console.error('✗ 导入失败：', err.message)
  process.exit(1)
})
