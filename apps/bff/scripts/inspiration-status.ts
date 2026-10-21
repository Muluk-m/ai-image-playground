/**
 * Bulk archive or restore inspiration items in one transaction.
 *
 *   bun run scripts/inspiration-status.ts <ids.json> [--key remove] [--restore] [--apply] [--operator <id>]
 *
 * ids.json is either a JSON array of ids or an object whose `--key` field (default `remove`) is one.
 * Without --apply nothing is written: it prints what would change. Default mode archives
 * `published` items; --restore puts `archived` items back to `published` (the reverse run).
 * Items keep their records, prompts and assets either way; nothing is hard-deleted.
 *
 * Restore only takes items that were published before (published_at set) and that still pass the
 * same publish validation the admin UI runs (fields, model in the loaded channels, skill). An
 * archived draft, or an item edited into an invalid state while archived, is reported as blocked
 * and left archived. Validation runs before the transaction; --apply then locks the validated rows
 * and aborts without writing if any column of any of them changed in between, so nothing
 * unchecked slips through.
 */
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { schema } from '@image-playground/db'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { config } from '../src/config'
import { close, db } from '../src/db/client'
import { initChannels } from '../src/lib/channels'
import {
  InspirationOperationError,
  refreshPublication,
  validateForPublish,
} from '../src/lib/inspirations'
import { parseArgs } from './inspiration-cli'

const USAGE =
  'inspiration-status.ts <ids.json> [--key remove] [--restore] [--apply] [--operator <id>]'
const { file, flags, options } = parseArgs(process.argv.slice(2), {
  flags: ['--restore', '--apply'],
  options: ['--key', '--operator'],
  usage: USAGE,
})
const restore = flags.has('--restore')
const apply = flags.has('--apply')
const key = options.get('--key') ?? 'remove'
const operatorId = options.get('--operator') ?? 'inspiration-status-script'
const from = restore ? ('archived' as const) : ('published' as const)
const to = restore ? ('published' as const) : ('archived' as const)

const raw: unknown = JSON.parse(await Bun.file(resolve(process.cwd(), file)).text())
const list = Array.isArray(raw) ? raw : (raw as Record<string, unknown> | null)?.[key]
if (!Array.isArray(list) || !list.every((id) => typeof id === 'string' && id.trim().length > 0)) {
  throw new Error(`expected a non-empty-string array (or field "${key}") in ${file}`)
}
const ids = [...new Set((list as string[]).map((id) => id.trim()))]

type Row = typeof schema.inspiration_items.$inferSelect
type Executor = Pick<typeof db, 'select'>
/** Stable comparison of a whole row (Date and jsonb values included, key order ignored). */
const fingerprint = (row: Row): string =>
  JSON.stringify(row, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  )

async function blockReason(row: Row): Promise<string | null> {
  if (!restore) return null
  if (row.published_at == null) return 'never published'
  try {
    await validateForPublish({
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
      coverKey: row.cover_key,
      imageKey: row.image_key,
      referenceImages: row.reference_images,
      skillName: row.skill_name,
      sourceUrl: row.source_url,
      author: row.author,
      sort: row.sort,
    })
    return null
  } catch (error) {
    if (error instanceof InspirationOperationError) return error.code
    throw error
  }
}

async function plan(executor: Executor) {
  const rows: Row[] = await executor
    .select()
    .from(schema.inspiration_items)
    .where(inArray(schema.inspiration_items.id, ids))
  const found = new Set(rows.map((row) => row.id))
  const targets: Row[] = []
  const blocked: { row: Row; reason: string }[] = []
  const skipped: Row[] = []
  for (const row of rows) {
    if (row.status !== from) {
      skipped.push(row)
      continue
    }
    const reason = await blockReason(row)
    if (reason) blocked.push({ row, reason })
    else targets.push(row)
  }
  return { targets, blocked, skipped, missing: ids.filter((id) => !found.has(id)) }
}

function report(result: Awaited<ReturnType<typeof plan>>) {
  const { targets, blocked, skipped, missing } = result
  console.log(
    `${apply ? 'APPLY' : 'DRY RUN'} ${from} -> ${to}: requested ${ids.length}, will change ${targets.length}, ` +
      `blocked ${blocked.length}, already elsewhere ${skipped.length}, missing ${missing.length}`,
  )
  for (const row of targets) console.log(`  ${row.id}\t${row.title}`)
  for (const { row, reason } of blocked)
    console.log(`  ! blocked ${row.id} (${reason})\t${row.title}`)
  if (missing.length) console.log(`missing: ${missing.join(', ')}`)
}

try {
  // Restore validates the recommended model against the loaded channels, as the BFF does.
  if (restore) {
    const channels = initChannels(config.channelsFile ?? undefined)
    for (const warning of channels.warnings) console.log(`  ! channels: ${warning}`)
  }
  // Validation (which may load skills) runs before the transaction so no row lock is held while it
  // awaits. The transaction then locks the validated rows and aborts if any of them changed since.
  const result = await plan(db)
  report(result)
  if (!apply) {
    console.log('Nothing written. Re-run with --apply to change status.')
  } else {
    const outcome = await db.transaction(async (tx) => {
      if (result.targets.length === 0) return null
      const locked: Row[] = await tx
        .select()
        .from(schema.inspiration_items)
        .where(
          inArray(
            schema.inspiration_items.id,
            result.targets.map((row) => row.id),
          ),
        )
        // Lock in id order so overlapping batches (this script or inspiration-repoint) can't deadlock.
        .orderBy(asc(schema.inspiration_items.id))
        .for('update')
      const current = new Map(locked.map((row) => [row.id, row]))
      // Compare the whole row, not just updated_at: any edit since validation (even one landing in
      // the same millisecond) means the validation result no longer applies.
      const moved = result.targets.filter((row) => {
        const now = current.get(row.id)
        return !now || fingerprint(now) !== fingerprint(row)
      })
      if (moved.length) {
        throw new Error(
          `changed since the check, nothing written; re-run: ${moved.map((row) => row.id).join(', ')}`,
        )
      }
      const now = Date.now()
      const changed = await tx
        .update(schema.inspiration_items)
        .set({ status: to, updated_at: now, updated_by: operatorId })
        .where(
          and(
            inArray(
              schema.inspiration_items.id,
              result.targets.map((row) => row.id),
            ),
            eq(schema.inspiration_items.status, from),
          ),
        )
        .returning({ id: schema.inspiration_items.id })
      if (changed.length === 0) return null
      await tx.insert(schema.operator_audits).values(
        changed.map(({ id }) => ({
          id: randomUUID(),
          operator_id: operatorId,
          action: `inspiration.${to}`,
          target_type: 'inspiration',
          target_id: id,
          details: { bulk: true, script: 'inspiration-status' },
          created_at: now,
        })),
      )
      return { changed: changed.length, publication: await refreshPublication(tx) }
    })
    if (!outcome) console.log('Changed 0 items; publication untouched.')
    else {
      console.log(
        `Changed ${outcome.changed} items; publication version ${outcome.publication.version} ` +
          `(${outcome.publication.item_count} published)`,
      )
    }
  }
} finally {
  await close()
}
