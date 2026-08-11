import { Database } from 'bun:sqlite'
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { Buffer } from 'node:buffer'
import { rmSync } from 'node:fs'
import * as schema from '@image-playground/db'
import { runMigrations, tasks } from '@image-playground/db'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import sharp from 'sharp'
import {
  buildDataUrl,
  deleteOutputBlobsOlderThan,
  getTaskBlob,
  insertTaskBlobs,
  listTaskBlobs,
  parseDataUrl,
  resolveInputDataUrls,
  rewriteInputDataUrls,
  transcodeInputBlobsToWebp,
} from '../../lib/blobStore'

const TEST_DB = './artifacts/test-blob-store.sqlite'

for (const suffix of ['', '-wal', '-shm']) rmSync(`${TEST_DB}${suffix}`, { force: true })
runMigrations(TEST_DB)

const sqlite = new Database(TEST_DB)
sqlite.exec('PRAGMA foreign_keys = ON;')
const db = drizzle(sqlite, { schema })

async function insertTask(id: string) {
  await db.insert(tasks).values({
    id,
    provider: 'openai-compat',
    model: 'test-model',
    status: 'queued',
    request_payload: { prompt: id },
    submitted_at: Date.now(),
  })
}

describe('blobStore', () => {
  beforeEach(async () => {
    await db.delete(tasks)
  })

  afterAll(() => {
    sqlite.close()
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${TEST_DB}${suffix}`, { force: true })
  })

  it('round-trips data URL bytes while preserving the MIME segment verbatim', () => {
    const bytes = Buffer.from([0, 1, 2, 127, 128, 255])
    const source = `data:image/png;charset=utf-8;base64,${bytes.toString('base64')}`

    const parsed = parseDataUrl(source)

    expect(parsed.mime).toBe('image/png;charset=utf-8')
    expect(parsed.data).toEqual(bytes)
    expect(buildDataUrl(parsed.mime, parsed.data)).toBe(source)
  })

  it('rewrites input data URLs and resolves mixed blob refs and legacy strings', async () => {
    await insertTask('input-round-trip')
    const first = buildDataUrl('image/png', Buffer.from('first-image'))
    const second = buildDataUrl('image/jpeg', Buffer.from('second-image'))
    const rewritten = rewriteInputDataUrls([first, second])

    expect(rewritten.refs).toEqual([{ $blob: 0 }, { $blob: 1 }])
    insertTaskBlobs('input-round-trip', rewritten.blobs, db)

    expect(await resolveInputDataUrls('input-round-trip', [rewritten.refs[0], second], db)).toEqual(
      [first, second],
    )
    expect((await getTaskBlob('input-round-trip', 'input', 1, db))?.mime).toBe('image/jpeg')
    expect((await listTaskBlobs('input-round-trip', 'input', db)).map((blob) => blob.idx)).toEqual([
      0, 1,
    ])
  })

  it('transcodes input bytes to WebP q90 without resizing', async () => {
    await insertTask('transcode')
    const png = await sharp({
      create: { width: 12, height: 8, channels: 4, background: '#336699' },
    })
      .png()
      .toBuffer()
    insertTaskBlobs('transcode', [{ kind: 'input', idx: 0, mime: 'image/png', data: png }], db)
    const expected = await sharp(png).webp({ quality: 90 }).toBuffer()

    expect(await transcodeInputBlobsToWebp('transcode', db)).toEqual({ transcoded: 1, failed: 0 })
    const blob = await getTaskBlob('transcode', 'input', 0, db)
    expect(blob?.mime).toBe('image/webp')
    expect(blob?.data).toEqual(expected)
    expect(await sharp(blob?.data).metadata()).toMatchObject({
      format: 'webp',
      width: 12,
      height: 8,
    })

    expect(await transcodeInputBlobsToWebp('transcode', db)).toEqual({
      transcoded: 0,
      failed: 0,
    })
    expect((await getTaskBlob('transcode', 'input', 0, db))?.data).toEqual(blob?.data)
  })

  it('retains each original blob when its transcode fails and continues with the others', async () => {
    await insertTask('partial-transcode')
    const valid = await sharp({
      create: { width: 2, height: 2, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer()
    const invalid = Buffer.from('not-an-image')
    insertTaskBlobs(
      'partial-transcode',
      [
        { kind: 'input', idx: 0, mime: 'image/png', data: valid },
        { kind: 'input', idx: 1, mime: 'image/original', data: invalid },
      ],
      db,
    )
    const errors: Record<string, unknown>[] = []

    expect(
      await transcodeInputBlobsToWebp('partial-transcode', db, {
        error(details) {
          errors.push(details)
        },
      }),
    ).toEqual({ transcoded: 1, failed: 1 })

    const blobs = await listTaskBlobs('partial-transcode', 'input', db)
    expect(blobs[0]?.mime).toBe('image/webp')
    expect(blobs[1]?.mime).toBe('image/original')
    expect(blobs[1]?.data).toEqual(invalid)
    expect(errors).toHaveLength(1)
  })

  it('deletes only output blobs strictly older than the retention cutoff', async () => {
    await insertTask('retention')
    const cutoff = 10_000
    insertTaskBlobs(
      'retention',
      [
        {
          kind: 'output',
          idx: 0,
          mime: 'image/png',
          data: Buffer.from('old'),
          createdAt: cutoff - 1,
        },
        { kind: 'output', idx: 1, mime: 'image/png', data: Buffer.from('edge'), createdAt: cutoff },
        {
          kind: 'output',
          idx: 2,
          mime: 'image/png',
          data: Buffer.from('new'),
          createdAt: cutoff + 1,
        },
        { kind: 'input', idx: 0, mime: 'image/png', data: Buffer.from('input'), createdAt: 1 },
      ],
      db,
    )

    expect(await deleteOutputBlobsOlderThan(cutoff, db)).toBe(1)
    expect((await listTaskBlobs('retention', 'output', db)).map((blob) => blob.idx)).toEqual([1, 2])
    expect(await getTaskBlob('retention', 'input', 0, db)).toBeDefined()
  })

  it('cascades blob deletion when task metadata is purged', async () => {
    await insertTask('cascade')
    insertTaskBlobs(
      'cascade',
      [{ kind: 'input', idx: 0, mime: 'image/png', data: Buffer.from('input') }],
      db,
    )

    await db.delete(tasks)

    expect(await listTaskBlobs('cascade', 'input', db)).toEqual([])
  })
})
