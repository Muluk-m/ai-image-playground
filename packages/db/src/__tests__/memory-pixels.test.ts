import { afterAll, describe, expect, it } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { composeQueuePersistence } from '../compose-persistence'
import { MemoryPixelStore } from '../memory-pixels'
import { runPgMigrations } from '../pg-migrate'
import { PgQueuePersistence } from '../pg-persistence'
import * as schema from '../pg-schema'

const pglite = await PGlite.create()
await runPgMigrations(async (sql) => {
  await pglite.exec(sql)
})
const tasks = new PgQueuePersistence(drizzle(pglite, { schema }))
const pixels = new MemoryPixelStore()
const persistence = composeQueuePersistence(tasks, pixels)

describe('memory pixel store', () => {
  afterAll(async () => {
    await pglite.close()
  })

  it('keeps pixel bytes out of the task table and serves them by index', async () => {
    const created = await persistence.submit({
      provider: 'openai-compat',
      model: 'm',
      request: { prompt: 'cat', device_id: 'd-aaaaaaaa', input_images: [{ $blob: 0 }] },
      clientRequestId: null,
      deviceId: 'd-aaaaaaaa',
      n: 1,
      pixels: [{ kind: 'input', idx: 0, mime: 'image/png', data: Buffer.from('in') }],
    })
    expect(created.kind).toBe('created')
    if (created.kind !== 'created') return

    const blobCount = await pglite.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM task_blobs',
    )
    expect(blobCount.rows[0]?.n).toBe('0')
    expect((await persistence.pixels.get(created.id, 'input', 0))?.data).toEqual(Buffer.from('in'))

    await persistence.tasks.claim(created.id, Date.now())
    expect(
      await persistence.completeWithPixels(
        created.id,
        { ok: true },
        [{ kind: 'output', idx: 0, mime: 'image/png', data: Buffer.from('out') }],
        Date.now(),
      ),
    ).toBe(true)

    const output = await persistence.pixels.get(created.id, 'output', 0)
    expect(output?.mime).toBe('image/png')
    expect(output?.data).toEqual(Buffer.from('out'))
    const blobsAfter = await pglite.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM task_blobs',
    )
    expect(blobsAfter.rows[0]?.n).toBe('0')
  })

  it('returns undefined when the object is missing', async () => {
    expect(await pixels.get('missing', 'output', 0)).toBeUndefined()
  })
})
