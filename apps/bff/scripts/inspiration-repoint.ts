/**
 * Point inspiration items' cover/image at absolute URLs through updateInspirationItem
 * (the same path as the admin PUT /internal/admin/inspirations/:id). publicAssetUrl() passes
 * absolute http(s) keys through unchanged.
 *
 *   bun run scripts/inspiration-repoint.ts <map.json> [--apply] [--operator <id>]
 * map.json: { "<id>": { "cover": "<url>?w=320&q=85", "image": "<url>" }, ... }
 * (mirrors the old cms-r2 rows: cover = thumbnail URL with resize query, image = full URL)
 *
 * The map is validated as a whole (https URLs, known ids) before anything is written. Published
 * items go through the admin publish validation on update, so channels are loaded and the dry run
 * runs the same check up front. Each item is re-read right before its update so a concurrent admin
 * edit of other fields is not overwritten with a stale copy. Items already pointing at the target
 * URLs are skipped, so a re-run is a no-op.
 */
import { resolve } from 'node:path'
import type { InspirationAdminItem, InspirationWriteInput } from '@image-playground/shared'
import { config } from '../src/config'
import { close } from '../src/db/client'
import { initChannels } from '../src/lib/channels'
import {
  getInspirationItem,
  InspirationOperationError,
  updateInspirationItem,
  validateForPublish,
} from '../src/lib/inspirations'
import { parseArgs } from './inspiration-cli'

const USAGE = 'inspiration-repoint.ts <map.json> [--apply] [--operator <id>]'
const { file, flags, options } = parseArgs(process.argv.slice(2), {
  flags: ['--apply'],
  options: ['--operator'],
  usage: USAGE,
})
const apply = flags.has('--apply')
const operatorId = options.get('--operator') ?? 'inspiration-repoint-script'

const isHttps = (value: unknown): value is string => {
  if (typeof value !== 'string') return false
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

const withUrls = (
  item: InspirationAdminItem,
  url: { cover: string; image: string },
): InspirationWriteInput => ({
  id: item.id,
  kind: item.kind,
  featured: item.featured,
  title: item.title,
  description: item.description,
  categoryId: item.categoryId,
  prompt: item.prompt,
  recommendedProvider: item.recommendedProvider,
  recommendedModel: item.recommendedModel,
  params: item.params,
  tags: item.tags,
  coverKey: url.cover,
  imageKey: url.image,
  referenceImages: item.referenceImages,
  skillName: item.skillName,
  sourceUrl: item.sourceUrl,
  author: item.author,
  sort: item.sort,
})

try {
  const raw: unknown = JSON.parse(await Bun.file(resolve(process.cwd(), file)).text())
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${file} must be an object of { "<id>": { cover, image } }`)
  }
  const channels = initChannels(config.channelsFile ?? undefined)
  for (const warning of channels.warnings) console.log(`  ! channels: ${warning}`)
  const problems: string[] = []
  const rows: { item: InspirationAdminItem; url: { cover: string; image: string } }[] = []
  let unchanged = 0
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const url = value as { cover?: unknown; image?: unknown } | null
    if (!url || typeof url !== 'object' || !isHttps(url.cover) || !isHttps(url.image)) {
      problems.push(`${id}: cover and image must both be https URLs`)
      continue
    }
    const target = { cover: url.cover, image: url.image }
    const item = await getInspirationItem(id)
    if (!item) {
      problems.push(`${id}: missing`)
      continue
    }
    if (item.coverKey === target.cover && item.imageKey === target.image) {
      unchanged++
      continue
    }
    if (item.status === 'published') {
      try {
        await validateForPublish(withUrls(item, target))
      } catch (error) {
        if (!(error instanceof InspirationOperationError)) throw error
        problems.push(`${id}: ${error.code} (published items are re-validated on update)`)
        continue
      }
    }
    rows.push({ item, url: target })
  }
  console.log(
    `${apply ? 'APPLY' : 'DRY RUN'}: ${rows.length} to update, ${unchanged} already pointing, ` +
      `${problems.length} problems`,
  )
  for (const { item, url } of rows)
    console.log(`  ${item.id}\t${item.status}\t${item.coverKey} -> ${url.cover} | ${url.image}`)
  for (const p of problems) console.log(`  ! ${p}`)
  if (problems.length) process.exitCode = 1
  else if (!apply) console.log('Nothing written. Re-run with --apply to update.')
  else {
    for (const { item, url } of rows) {
      const fresh = await getInspirationItem(item.id)
      if (!fresh) throw new Error(`${item.id}: disappeared before update`)
      await updateInspirationItem(item.id, withUrls(fresh, url), operatorId)
      console.log(`updated ${item.id}`)
    }
  }
} finally {
  await close()
}
