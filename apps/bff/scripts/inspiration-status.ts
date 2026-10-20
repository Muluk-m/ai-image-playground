/**
 * Bulk archive or restore inspiration items in one transaction.
 *
 *   bun run scripts/inspiration-status.ts <ids.json> [--key remove] [--restore] [--apply] [--operator <id>]
 *
 * ids.json is either a JSON array of ids or an object whose `--key` field (default `remove`) is one.
 * Without --apply nothing is written: it prints what would change. Default mode archives
 * `published` items; --restore puts `archived` items back to `published` (the reverse run).
 * Items keep their records, prompts and assets either way, so every run is reversible. Restoring
 * deliberately skips the per-item publish validation the admin UI runs: it only reverts items that
 * were published before, which is what makes it a true undo.
 */
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { schema } from '@image-playground/db'
import { and, eq, inArray } from 'drizzle-orm'
import { close, db } from '../src/db/client'
import { refreshPublication } from '../src/lib/inspirations'

const valueOptions = new Set(['--key', '--operator'])
const args = process.argv.slice(2)
const options = new Map<string, string>()
const flags = new Set<string>()
const positional: string[] = []
for (let index = 0; index < args.length; index++) {
  const arg = args[index] ?? ''
  if (valueOptions.has(arg)) options.set(arg, args[++index] ?? '')
  else if (arg.startsWith('--')) flags.add(arg)
  else positional.push(arg)
}
const flag = (name: string) => flags.has(name)
const option = (name: string) => options.get(name) || undefined
const file = positional[0]
if (!file) {
  throw new Error(
    'usage: inspiration-status.ts <ids.json> [--key remove] [--restore] [--apply] [--operator <id>]',
  )
}
const restore = flag('--restore')
const apply = flag('--apply')
const key = option('--key') ?? 'remove'
const operatorId = option('--operator') ?? 'inspiration-status-script'
const from = restore ? ('archived' as const) : ('published' as const)
const to = restore ? ('published' as const) : ('archived' as const)

const raw: unknown = JSON.parse(await Bun.file(resolve(process.cwd(), file)).text())
const list = Array.isArray(raw) ? raw : (raw as Record<string, unknown>)?.[key]
if (!Array.isArray(list) || !list.every((id) => typeof id === 'string' && id.length > 0)) {
  throw new Error(`expected a string array (or field "${key}") in ${file}`)
}
const ids = [...new Set(list as string[])]

try {
  const rows = await db
    .select({
      id: schema.inspiration_items.id,
      status: schema.inspiration_items.status,
      title: schema.inspiration_items.title,
    })
    .from(schema.inspiration_items)
    .where(inArray(schema.inspiration_items.id, ids))
  const found = new Map(rows.map((row) => [row.id, row]))
  const missing = ids.filter((id) => !found.has(id))
  const targets = rows.filter((row) => row.status === from)
  const skipped = rows.filter((row) => row.status !== from)
  console.log(
    `${apply ? 'APPLY' : 'DRY RUN'} ${from} -> ${to}: requested ${ids.length}, will change ${targets.length}, ` +
      `already elsewhere ${skipped.length}, missing ${missing.length}`,
  )
  for (const row of targets) console.log(`  ${row.id}\t${row.title}`)
  if (missing.length) console.log(`missing: ${missing.join(', ')}`)
  if (!apply || targets.length === 0) {
    if (!apply) console.log('Nothing written. Re-run with --apply to change status.')
  } else {
    const targetIds = targets.map((row) => row.id)
    const publication = await db.transaction(async (tx) => {
      const now = Date.now()
      const changed = await tx
        .update(schema.inspiration_items)
        .set({ status: to, updated_at: now, updated_by: operatorId })
        .where(
          and(
            inArray(schema.inspiration_items.id, targetIds),
            eq(schema.inspiration_items.status, from),
          ),
        )
        .returning({ id: schema.inspiration_items.id })
      await tx.insert(schema.operator_audits).values(
        changed.map(({ id }) => ({
          id: randomUUID(),
          operator_id: operatorId,
          action: `inspiration.${to}`,
          target_type: 'inspiration',
          target_id: id,
          details: { bulk: true },
          created_at: now,
        })),
      )
      return { changed: changed.length, publication: await refreshPublication(tx) }
    })
    console.log(
      `Changed ${publication.changed} items; publication version ${publication.publication.version} ` +
        `(${publication.publication.item_count} published)`,
    )
  }
} finally {
  await close()
}
