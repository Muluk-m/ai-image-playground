import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { DAILY_QUOTA_LIMIT } from '@image-playground/shared'
import { drizzle } from 'drizzle-orm/pglite'
import { runPgMigrations } from '../pg-migrate'
import { PgQueuePersistence } from '../pg-persistence'
import * as schema from '../pg-schema'

const pglite = await PGlite.create()
await runPgMigrations(async (sql) => {
  await pglite.exec(sql)
})
const persistence = new PgQueuePersistence(drizzle(pglite, { schema }))

describe('postgres queue persistence (pglite)', () => {
  beforeEach(async () => {
    await pglite.exec('DELETE FROM task_blobs; DELETE FROM tasks; DELETE FROM daily_quota;')
  })

  afterAll(async () => {
    await pglite.close()
  })

  it('submits, stores pixels, and claims once', async () => {
    const created = await persistence.submit({
      provider: 'openai-compat',
      model: 'm',
      request: { prompt: 'cat', device_id: 'd-aaaaaaaa' },
      clientRequestId: 'client-req-1',
      deviceId: 'd-aaaaaaaa',
      n: 1,
      pixels: [{ kind: 'input', idx: 0, mime: 'image/png', data: Buffer.from('in') }],
    })
    expect(created.kind).toBe('created')
    if (created.kind !== 'created') return

    const replay = await persistence.submit({
      provider: 'openai-compat',
      model: 'm',
      request: { prompt: 'cat', device_id: 'd-aaaaaaaa' },
      clientRequestId: 'client-req-1',
      deviceId: 'd-aaaaaaaa',
      n: 1,
      pixels: [],
    })
    expect(replay).toMatchObject({ kind: 'replay', id: created.id })

    const input = await persistence.pixels.get(created.id, 'input', 0)
    expect(input?.data).toEqual(Buffer.from('in'))
    expect(await persistence.tasks.claim(created.id, Date.now())).toBe(true)
    expect(await persistence.tasks.claim(created.id, Date.now())).toBe(false)
  })

  it('rejects submit when daily quota is exhausted', async () => {
    const first = await persistence.submit({
      provider: 'gemini',
      model: 'g',
      request: { prompt: 'x', device_id: 'd-bbbbbbbb', n: DAILY_QUOTA_LIMIT },
      clientRequestId: null,
      deviceId: 'd-bbbbbbbb',
      n: DAILY_QUOTA_LIMIT,
      pixels: [],
    })
    expect(first.kind).toBe('created')

    const rejected = await persistence.submit({
      provider: 'gemini',
      model: 'g',
      request: { prompt: 'y', device_id: 'd-bbbbbbbb' },
      clientRequestId: null,
      deviceId: 'd-bbbbbbbb',
      n: 1,
      pixels: [],
    })
    expect(rejected.kind).toBe('quota_rejected')
  })

  it('marks leftover in_progress rows interrupted and does not auto-retry them', async () => {
    const created = await persistence.submit({
      provider: 'openai-compat',
      model: 'm',
      request: { prompt: 'cat', device_id: 'd-cccccccc' },
      clientRequestId: null,
      deviceId: 'd-cccccccc',
      n: 1,
      pixels: [],
    })
    if (created.kind !== 'created') throw new Error('expected create')
    await persistence.tasks.claim(created.id, Date.now())
    expect(await persistence.tasks.recoverInterrupted(Date.now())).toBe(1)
    const row = await persistence.tasks.getById(created.id)
    expect(row?.status).toBe('failed')
    expect(row?.error_type).toBe('interrupted')
    expect(await persistence.tasks.claim(created.id, Date.now())).toBe(false)
  })

  it('rejects sqlite file paths on the postgres factory', async () => {
    const { createPostgresPersistence } = await import('../pg-persistence')
    await expect(
      createPostgresPersistence('../../artifacts/image-playground.sqlite'),
    ).rejects.toThrow(/postgres:\/\//)
  })
})
