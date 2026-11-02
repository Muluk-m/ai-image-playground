/**
 * 一次性回填 inspiration_items.thumb_width / thumb_height。
 * 按每条封面图取像素尺寸并写回，然后刷新已发布清单。
 *
 * 默认拒绝执行。确认要打哪一个库之后再设 BACKFILL_INSPIRATION_DIMENSIONS=1。
 * 不要对生产或测试环境随手运行。
 */
if (process.env.BACKFILL_INSPIRATION_DIMENSIONS !== '1') {
  console.error(
    'Refusing to backfill inspiration dimensions. Set BACKFILL_INSPIRATION_DIMENSIONS=1 to run this once.',
  )
  process.exit(1)
}

const databaseUrl = process.env.DATABASE_URL?.trim()
if (!databaseUrl) throw new Error('DATABASE_URL is required')

const { runMigrations } = await import('@image-playground/db')
const { eq } = await import('drizzle-orm')
const { close: closeDb, db, schema } = await import('../src/db/client')
const { imageDimensions } = await import('../src/lib/image-dimensions')
const { refreshPublication } = await import('../src/lib/inspirations')

export {}

function coverUrl(key: string): string {
  if (/^https?:\/\//.test(key)) return key
  const base = process.env.PUBLIC_ASSET_BASE_URL?.trim().replace(/\/+$/, '')
  if (!base) throw new Error(`PUBLIC_ASSET_BASE_URL is required for cover key ${key}`)
  return `${base}/${key.replace(/^\/+/, '')}`
}

await runMigrations(databaseUrl)
let updated = 0
let skipped = 0
try {
  const rows = await db
    .select({
      id: schema.inspiration_items.id,
      coverKey: schema.inspiration_items.cover_key,
      thumbWidth: schema.inspiration_items.thumb_width,
      thumbHeight: schema.inspiration_items.thumb_height,
    })
    .from(schema.inspiration_items)

  for (const row of rows) {
    if (row.thumbWidth && row.thumbHeight && row.thumbWidth > 0 && row.thumbHeight > 0) {
      skipped += 1
      continue
    }
    try {
      const response = await fetch(coverUrl(row.coverKey), { signal: AbortSignal.timeout(20_000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const size = imageDimensions(new Uint8Array(await response.arrayBuffer()))
      if (!size) throw new Error('unrecognized image')
      await db
        .update(schema.inspiration_items)
        .set({ thumb_width: size.width, thumb_height: size.height, updated_at: Date.now() })
        .where(eq(schema.inspiration_items.id, row.id))
      updated += 1
      console.log(`${row.id} ${size.width}x${size.height}`)
    } catch (error) {
      skipped += 1
      console.error(`${row.id} skipped: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  await db.transaction(async (tx) => {
    await refreshPublication(tx)
  })
  console.log(`Inspiration dimension backfill complete: updated ${updated}, skipped ${skipped}`)
} finally {
  await closeDb()
}
