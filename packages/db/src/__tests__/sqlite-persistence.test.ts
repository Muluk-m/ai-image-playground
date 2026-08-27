import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, unlinkSync } from 'node:fs'
import { DAILY_QUOTA_LIMIT } from '@image-playground/shared'
import { runMigrations } from '../migrate'
import { createSqlitePersistence } from '../sqlite-persistence'

const TEST_DB = './artifacts/test-sqlite-persistence.sqlite'

mkdirSync('./artifacts', { recursive: true })

function resetFile() {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(`${TEST_DB}${suffix}`)
    } catch {}
  }
}

resetFile()
runMigrations(TEST_DB)
const persistence = createSqlitePersistence(TEST_DB)

describe('sqlite queue persistence', () => {
  beforeEach(async () => {
    persistence.db.delete(persistence.schema.tasks).run()
    persistence.db.delete(persistence.schema.daily_quota).run()
  })

  afterAll(() => {
    persistence.sqlite.close()
    resetFile()
  })

  it('submits a queued task, stores pixels, and claims once', async () => {
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

  it('writes output pixels only when the task is still in progress', async () => {
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

    const ok = await persistence.completeWithPixels(
      created.id,
      { ok: true },
      [{ kind: 'output', idx: 0, mime: 'image/png', data: Buffer.from('out') }],
      Date.now(),
    )
    expect(ok).toBe(true)
    expect((await persistence.pixels.get(created.id, 'output', 0))?.data).toEqual(
      Buffer.from('out'),
    )

    expect(await persistence.completeWithPixels(created.id, { ok: true }, [], Date.now())).toBe(
      false,
    )
  })
})
