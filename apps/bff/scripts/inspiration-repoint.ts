/**
 * Point inspiration items' cover/image at absolute URLs. publicAssetUrl() passes absolute
 * http(s) keys through unchanged.
 *
 *   bun run scripts/inspiration-repoint.ts <map.json> [--apply] [--operator <id>] [--hosts <a,b>]
 * map.json: { "<id>": { "cover": "<url>?w=320&q=85", "image": "<url>" }, ... }
 * (mirrors the old cms-r2 rows: cover = thumbnail URL with resize query, image = full URL)
 *
 * The map is validated as a whole before anything is written: every URL must be https on an
 * allowed host (default cms-r2.deepclick.com, override with --hosts), without credentials or an
 * explicit port (not even :443), and is stored in its normalized form; every id must exist; published items run
 * the same publish validation the admin edit runs (channels are loaded for it).
 * --apply then updates the whole batch in ONE transaction: it locks every id in the map (including
 * the ones already pointing at their target), aborts without writing if any column of any of them
 * changed since the check, writes only cover_key / image_key in a single UPDATE, records an `inspiration.update`
 * audit per changed item and refreshes the publication once. Either every item ends up at its
 * target or nothing is written. A re-run is a no-op.
 */
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { InspirationWriteInput } from '@image-playground/shared'
import { inArray, type SQL, sql } from 'drizzle-orm'
import { config } from '../src/config'
import { close, db, schema } from '../src/db/client'
import { initChannels } from '../src/lib/channels'
import {
  InspirationOperationError,
  refreshPublication,
  validateForPublish,
} from '../src/lib/inspirations'
import { parseArgs } from './inspiration-cli'

const USAGE = 'inspiration-repoint.ts <map.json> [--apply] [--operator <id>] [--hosts <a,b>]'
const { file, flags, options } = parseArgs(process.argv.slice(2), {
  flags: ['--apply'],
  options: ['--operator', '--hosts'],
  usage: USAGE,
})
const apply = flags.has('--apply')
const operatorId = options.get('--operator') ?? 'inspiration-repoint-script'
const hosts = new Set(
  (options.get('--hosts') ?? 'cms-r2.deepclick.com')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean),
)

type Row = typeof schema.inspiration_items.$inferSelect
/** Keeps one transaction's locks, CASE update and audit insert well within PostgreSQL limits. */
const MAX_BATCH = 1000
type Target = { cover: string; image: string }

/** Stable comparison of a whole row (Date and jsonb values included, key order ignored). */
const fingerprint = (row: Row): string =>
  JSON.stringify(row, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  )

/** Normalized https URL on an allowed host, or a reason it is rejected. */
function checkUrl(value: unknown): { href: string } | { error: string } {
  if (typeof value !== 'string') return { error: 'not a string' }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { error: 'not a URL' }
  }
  if (url.protocol !== 'https:') return { error: 'not https' }
  if (url.username || url.password) return { error: 'contains credentials' }
  // URL normalizes the default :443 away, so check the raw authority for any explicit port.
  const authority =
    value
      .trim()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
      .split(/[/?#\\]/)[0] ?? ''
  if (url.port || /:\d*$/.test(authority.replace(/^\[[^\]]*\]/, ''))) {
    return { error: 'explicit port' }
  }
  if (!hosts.has(url.hostname)) return { error: `host ${url.hostname} not allowed` }
  return { href: url.href }
}

const withUrls = (row: Row, url: Target): InspirationWriteInput => ({
  id: row.id,
  kind: row.kind,
  featured: row.featured,
  title: row.title,
  description: row.description,
  categoryId: row.category_id,
  prompt: row.prompt,
  recommendedProvider: row.recommended_provider,
  recommendedModel: row.recommended_model,
  params: row.params,
  tags: row.tags,
  coverKey: url.cover,
  imageKey: url.image,
  referenceImages: row.reference_images,
  skillName: row.skill_name,
  sourceUrl: row.source_url,
  author: row.author,
  sort: row.sort,
})

try {
  const raw: unknown = JSON.parse(await Bun.file(resolve(process.cwd(), file)).text())
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${file} must be an object of { "<id>": { cover, image } }`)
  }
  const channels = initChannels(config.channelsFile ?? undefined)
  for (const warning of channels.warnings) console.log(`  ! channels: ${warning}`)
  const problems: string[] = []
  const entryCount = Object.keys(raw).length
  if (entryCount > MAX_BATCH) {
    problems.push(`map has ${entryCount} entries; split it into batches of at most ${MAX_BATCH}`)
  }
  const targets = new Map<string, Target>()
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry = value as { cover?: unknown; image?: unknown } | null
    if (!entry || typeof entry !== 'object') {
      problems.push(`${id}: expected { cover, image }`)
      continue
    }
    const cover = checkUrl(entry.cover)
    const image = checkUrl(entry.image)
    if ('error' in cover) problems.push(`${id}: cover ${cover.error}`)
    if ('error' in image) problems.push(`${id}: image ${image.error}`)
    if ('href' in cover && 'href' in image)
      targets.set(id, { cover: cover.href, image: image.href })
  }
  const snapshot: Row[] = targets.size
    ? await db
        .select()
        .from(schema.inspiration_items)
        .where(inArray(schema.inspiration_items.id, [...targets.keys()]))
    : []
  const byId = new Map(snapshot.map((row) => [row.id, row]))
  const rows: { row: Row; url: Target }[] = []
  let unchanged = 0
  for (const [id, url] of targets) {
    const row = byId.get(id)
    if (!row) {
      problems.push(`${id}: missing`)
      continue
    }
    if (row.cover_key === url.cover && row.image_key === url.image) {
      unchanged++
      continue
    }
    if (row.status === 'published') {
      try {
        await validateForPublish(withUrls(row, url))
      } catch (error) {
        if (!(error instanceof InspirationOperationError)) throw error
        problems.push(`${id}: ${error.code} (published items are re-validated on update)`)
        continue
      }
    }
    rows.push({ row, url })
  }
  console.log(
    `${apply ? 'APPLY' : 'DRY RUN'}: ${rows.length} to update, ${unchanged} already pointing, ` +
      `${problems.length} problems`,
  )
  for (const { row, url } of rows)
    console.log(`  ${row.id}\t${row.status}\t${row.cover_key} -> ${url.cover} | ${url.image}`)
  for (const p of problems) console.log(`  ! ${p}`)
  if (problems.length) process.exitCode = 1
  else if (!apply) console.log('Nothing written. Re-run with --apply to update.')
  else if (rows.length === 0) console.log('Nothing to update.')
  else {
    const publication = await db.transaction(async (tx) => {
      // Lock every id in the map, not only the ones being written, so the batch as a whole is
      // checked: an item that was already at its target but got changed back also aborts.
      const locked: Row[] = await tx
        .select()
        .from(schema.inspiration_items)
        .where(
          inArray(
            schema.inspiration_items.id,
            snapshot.map((row) => row.id),
          ),
        )
        .for('update')
      const current = new Map(locked.map((row) => [row.id, row]))
      const moved = snapshot.filter((row) => {
        const now = current.get(row.id)
        return !now || fingerprint(now) !== fingerprint(row)
      })
      if (moved.length) {
        throw new Error(
          `changed since the check, nothing written; re-run: ${moved.map((row) => row.id).join(', ')}`,
        )
      }
      const now = Date.now()
      // One statement for the whole batch keeps the locked window short.
      const column = (pick: (url: Target) => string): SQL =>
        sql`CASE ${schema.inspiration_items.id} ${sql.join(
          rows.map(({ row, url }) => sql`WHEN ${row.id} THEN ${pick(url)}`),
          sql` `,
        )} END`
      const updated = await tx
        .update(schema.inspiration_items)
        .set({
          cover_key: column((url) => url.cover),
          image_key: column((url) => url.image),
          updated_at: now,
          updated_by: operatorId,
        })
        .where(
          inArray(
            schema.inspiration_items.id,
            rows.map(({ row }) => row.id),
          ),
        )
        .returning({ id: schema.inspiration_items.id })
      if (updated.length !== rows.length) {
        throw new Error(`expected ${rows.length} updates, got ${updated.length}; rolled back`)
      }
      await tx.insert(schema.operator_audits).values(
        rows.map(({ row, url }) => ({
          id: randomUUID(),
          operator_id: operatorId,
          action: 'inspiration.update',
          target_type: 'inspiration',
          target_id: row.id,
          details: {
            bulk: true,
            script: 'inspiration-repoint',
            from: { cover: row.cover_key, image: row.image_key },
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
