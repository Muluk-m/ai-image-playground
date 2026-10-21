/**
 * Point inspiration items' cover/image at absolute URLs. publicAssetUrl() passes absolute
 * http(s) keys through unchanged.
 *
 *   bun run scripts/inspiration-repoint.ts <map.json> [--apply] [--operator <id>]
 * map.json: { "<id>": { "cover": "<url>?w=320&q=85", "image": "<url>" }, ... }
 * (mirrors the old cms-r2 rows: cover = thumbnail URL with resize query, image = full URL)
 *
 * The map is validated as a whole (https URLs, known ids) and published items run the same publish
 * validation the admin edit runs (channels are loaded for it) before anything is written. --apply
 * then updates the whole batch in ONE transaction: it locks the rows, aborts without writing if any
 * changed since the check, writes only cover_key / image_key (never a stale copy of other fields),
 * records an `inspiration.update` audit per item and refreshes the publication once. Either every
 * item is repointed or none is. Items already pointing at the target URLs are skipped, so a re-run
 * is a no-op.
 */
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { InspirationAdminItem, InspirationWriteInput } from '@image-playground/shared'
import { eq, inArray } from 'drizzle-orm'
import { config } from '../src/config'
import { close, db, schema } from '../src/db/client'
import { initChannels } from '../src/lib/channels'
import {
  getInspirationItem,
  InspirationOperationError,
  refreshPublication,
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

const stamp = (value: unknown) => (value instanceof Date ? value.getTime() : Number(value))

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
  else if (rows.length === 0) console.log('Nothing to update.')
  else {
    const publication = await db.transaction(async (tx) => {
      const locked = await tx
        .select({
          id: schema.inspiration_items.id,
          updated_at: schema.inspiration_items.updated_at,
        })
        .from(schema.inspiration_items)
        .where(
          inArray(
            schema.inspiration_items.id,
            rows.map(({ item }) => item.id),
          ),
        )
        .for('update')
      const current = new Map(locked.map((row) => [row.id, stamp(row.updated_at)]))
      const moved = rows.filter(({ item }) => current.get(item.id) !== stamp(item.updatedAt))
      if (moved.length) {
        throw new Error(
          `changed since the check, nothing written; re-run: ${moved.map(({ item }) => item.id).join(', ')}`,
        )
      }
      const now = Date.now()
      for (const { item, url } of rows) {
        await tx
          .update(schema.inspiration_items)
          .set({
            cover_key: url.cover,
            image_key: url.image,
            updated_at: now,
            updated_by: operatorId,
          })
          .where(eq(schema.inspiration_items.id, item.id))
      }
      await tx.insert(schema.operator_audits).values(
        rows.map(({ item, url }) => ({
          id: randomUUID(),
          operator_id: operatorId,
          action: 'inspiration.update',
          target_type: 'inspiration',
          target_id: item.id,
          details: {
            bulk: true,
            script: 'inspiration-repoint',
            from: { cover: item.coverKey, image: item.imageKey },
            to: url,
          },
          created_at: now,
        })),
      )
      return refreshPublication(tx)
    })
    console.log(
      `Updated ${rows.length} items; publication version ${publication.version} ` +
        `(${publication.item_count} published)`,
    )
  }
} finally {
  await close()
}
