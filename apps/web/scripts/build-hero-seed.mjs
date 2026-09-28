#!/usr/bin/env node
/**
 * 从 public/inspiration-manifest.json 提取 HERO_SEED_IDS 列出的精选数据，
 * 写到 src/generated/heroSeed.json。
 *
 * - 让 hero 首屏不依赖远程 manifest fetch，立即可见
 * - bundle 体积增加约 6 KB（gzipped 约 2 KB），可接受
 * - 想换图就改 HERO_SEED_IDS 跑 `pnpm gen:hero-seed` 重新生成
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const MANIFEST_PATH = resolve(REPO_ROOT, 'public/inspiration-manifest.json')
const OUTPUT_PATH = resolve(REPO_ROOT, 'src/generated/heroSeed.json')

// 首页精选池：只从这批审核过的案例轮换，避免随机抽到图文不符的旧条目。
const HERO_SEED_IDS = [
  'gpt-image-2-travel-journal-edit', // 插画与艺术 - 真实输入图与手绘效果
  'gpt-image-2-room-sketch-render', // 建筑与空间 - 草图与写实效果
  'gpt-image-2-dumplings-editorial-poster', // 海报与字体 - 新版编辑设计
  'i25-01', // 海报与字体 - 街头潮牌广告
  'i25-02', // 产品与电商 - 白底产品图
  'i25-03', // 图表与信息图 - 教学图解
  'i25-04', // 摄影与写实 - 人像特写
  'i25-08', // 人物与角色 - 角色设定
]

// 与 InspirationItem (apps/web/src/features/inspiration/types.ts) 保持同步：
// 缺失字段时 build fail，避免坏数据进 bundle 后 applyInspiration 运行时炸。
const REQUIRED_STRING_FIELDS = [
  'id',
  'title',
  'prompt',
  'thumbnailUrl',
  'recommendedModel',
  'recommendedProvider',
  'category',
]

function validateSeedItem(item, index) {
  const errors = []
  for (const f of REQUIRED_STRING_FIELDS) {
    if (typeof item[f] !== 'string' || item[f].length === 0) {
      errors.push(`第 ${index} 条 (${item.id ?? '?'})：字段 ${f} 必须是非空字符串`)
    }
  }
  if (!item.params || typeof item.params.size !== 'string' || item.params.size.length === 0) {
    errors.push(`第 ${index} 条 (${item.id ?? '?'})：params.size 必须是非空字符串`)
  }
  return errors
}

const manifestRaw = readFileSync(MANIFEST_PATH, 'utf8')
const manifest = JSON.parse(manifestRaw)
if (!Array.isArray(manifest.items)) {
  console.error('manifest.items 不是数组，无法提取 hero seed')
  process.exit(1)
}

const idMap = new Map(manifest.items.map((it) => [it.id, it]))
const missing = HERO_SEED_IDS.filter((id) => !idMap.has(id))
if (missing.length > 0) {
  console.error(`HERO_SEED_IDS 中以下 id 在 manifest 中找不到：${missing.join(', ')}`)
  process.exit(1)
}

// 旧 manifest 没有 kind：种子按效果图落盘，类型与线上清单一致。
const seed = HERO_SEED_IDS.map((id) => ({ kind: 'showcase', ...idMap.get(id) }))

const validationErrors = seed.flatMap((item, i) => validateSeedItem(item, i))
if (validationErrors.length > 0) {
  console.error('hero seed schema 校验失败：')
  for (const err of validationErrors) console.error(`  - ${err}`)
  process.exit(1)
}

mkdirSync(dirname(OUTPUT_PATH), { recursive: true })
writeFileSync(OUTPUT_PATH, `${JSON.stringify(seed, null, 2)}\n`, 'utf8')

console.log(`✓ 已写 hero seed（${seed.length} 条）→ ${OUTPUT_PATH}`)
for (const item of seed) {
  console.log(`  ${item.id}  ${item.category}  ${item.title}`)
}
