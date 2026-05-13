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
// 原图（详情页 + 「查看原图」）走 jsDelivr CDN：GitHub raw 限流 + 国内访问差。
const IMAGE_BASE_FULL = `https://cdn.jsdelivr.net/gh/${REPO_OWNER}/${REPO_NAME}@${REPO_BRANCH}/data`
// 缩略图（网格列表）经 images.weserv.nl 在线压缩到 400px WebP（q=75，免费图片代理 + CDN）。
// 单张从 ~150KB JPEG 压到 ~25KB WebP，国内访问更稳定。
const THUMBNAIL_PROXY = 'https://images.weserv.nl/'

function buildThumbnailUrl(imagePath) {
  // wsrv 要求 url 参数去掉 https:// 前缀
  const upstream = `cdn.jsdelivr.net/gh/${REPO_OWNER}/${REPO_NAME}@${REPO_BRANCH}/data${imagePath}`
  const params = new URLSearchParams({ url: upstream, w: '400', output: 'webp', q: '75' })
  return `${THUMBNAIL_PROXY}?${params.toString()}`
}

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..')
const OUTPUT = path.join(ROOT, 'public', 'inspiration-manifest.json')

const DEFAULT_PARAMS = { size: 'auto', n: 1 }
const RECOMMENDED_MODEL = 'gpt-image-2'
const RECOMMENDED_PROVIDER = 'openai-compat'

// 上游分类 / 风格 / 场景为英文；映射到中文展示。未命中映射保留英文原文。
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
  // styles
  '3D': '3D',
  'Architecture': '建筑',
  'Brand': '品牌',
  'Character': '人物',
  'Characters': '人物',
  'Charts': '图表',
  'Classical': '古典',
  'Documents': '文档',
  'History': '历史',
  'Illustration': '插画',
  'Infographic': '信息图',
  'Other Use Cases': '其他',
  'Photography': '摄影',
  'Poster': '海报',
  'Product': '产品',
  'Products': '产品',
  'Realistic': '写实',
  'Scenes': '场景',
  'UI': 'UI',
  // scenes
  'Commerce': '商业',
  'Creative': '创意',
  'Education': '教育',
  'Fashion': '时尚',
  'Food': '美食',
  'Social': '社交',
  'Story': '故事',
  'Tech': '科技',
  'Travel': '旅行',
}

const tr = (map, value) => map[value] ?? value
const trList = (map, values) => Array.from(new Set(values.map((v) => tr(map, v))))

function transformCase(raw) {
  if (!raw || typeof raw.id !== 'number' || typeof raw.prompt !== 'string' || typeof raw.title !== 'string' || typeof raw.image !== 'string') {
    return null
  }
  const rawTags = [...(Array.isArray(raw.styles) ? raw.styles : []), ...(Array.isArray(raw.scenes) ? raw.scenes : [])]
  const tags = trList(TAG_ZH, rawTags)
  const rawCategory = typeof raw.category === 'string' && raw.category ? raw.category : 'Other Use Cases'
  const item = {
    id: `awesome-${raw.id}`,
    title: raw.title,
    prompt: raw.prompt,
    thumbnailUrl: buildThumbnailUrl(raw.image),
    imageUrl: `${IMAGE_BASE_FULL}${raw.image}`,
    params: { ...DEFAULT_PARAMS },
    recommendedModel: RECOMMENDED_MODEL,
    recommendedProvider: RECOMMENDED_PROVIDER,
    category: tr(CATEGORY_ZH, rawCategory),
  }
  if (tags.length) item.tags = tags
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

  // 保持上游顺序（上游本身就是从最新 id 开始往下排）
  const manifest = {
    version: 1,
    updatedAt: new Date().toISOString(),
    categories: Array.isArray(upstream.categories)
      ? trList(CATEGORY_ZH, upstream.categories)
      : undefined,
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
