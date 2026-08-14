import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { migrateBlobs } from './migrate-blobs'

const DAY = 24 * 60 * 60 * 1_000
const NOW = Date.UTC(2026, 7, 11, 12)

interface TaskFixture {
  id: string
  provider: 'openai-compat' | 'gemini'
  status: 'queued' | 'completed'
  request: Record<string, unknown>
  result?: Record<string, unknown>
  submittedAt: number
  completedAt?: number
}

interface StoredBlob {
  task_id: string
  kind: 'input' | 'output'
  idx: number
  mime: string
  data: Uint8Array
  created_at: number
}

const tempDirs: string[] = []

function createLegacyDb(fixtures: TaskFixture[]): { dbPath: string; sqlite: Database } {
  const dir = mkdtempSync(join(tmpdir(), 'task-blob-migration-'))
  tempDirs.push(dir)
  const dbPath = join(dir, 'tasks.sqlite')
  const sqlite = new Database(dbPath)
  sqlite.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT NOT NULL,
      request_payload TEXT NOT NULL,
      result_payload TEXT,
      error_message TEXT,
      error_type TEXT,
      submitted_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER
    );
  `)
  const insert = sqlite.prepare(`
    INSERT INTO tasks (
      id, provider, model, status, request_payload, result_payload, submitted_at, completed_at
    ) VALUES (?, ?, 'fixture-model', ?, ?, ?, ?, ?)
  `)
  for (const fixture of fixtures) {
    insert.run(
      fixture.id,
      fixture.provider,
      fixture.status,
      JSON.stringify(fixture.request),
      fixture.result === undefined ? null : JSON.stringify(fixture.result),
      fixture.submittedAt,
      fixture.completedAt ?? null,
    )
  }
  return { dbPath, sqlite }
}

function dataUrl(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
}

function snapshot(sqlite: Database): unknown {
  return {
    tasks: sqlite
      .query('SELECT id, request_payload, result_payload, device_id FROM tasks ORDER BY id')
      .all(),
    blobs: sqlite
      .query(`
        SELECT id, task_id, kind, idx, mime, hex(data) AS data, created_at
        FROM task_blobs
        ORDER BY task_id, kind, idx
      `)
      .all(),
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('task blob migration', () => {
  it('externalizes mixed legacy inputs and recent results while dropping expired results', async () => {
    const png = await sharp({
      create: { width: 2, height: 2, channels: 4, background: '#cc3300' },
    })
      .png()
      .toBuffer()
    const jpeg = await sharp({
      create: { width: 2, height: 2, channels: 3, background: '#0066cc' },
    })
      .jpeg()
      .toBuffer()
    const existingRef = { $blob: 0 }
    const { dbPath, sqlite } = createLegacyDb([
      {
        id: 'a-new-openai',
        provider: 'openai-compat',
        status: 'completed',
        submittedAt: NOW - 2 * DAY,
        completedAt: NOW - DAY,
        request: {
          device_id: 'device-new',
          prompt: 'keep this prompt',
          input_images: [dataUrl('image/png', png)],
          input_fidelity: 'high',
        },
        result: {
          created: 123,
          size: '1024x1024',
          data: [
            { b64_json: png.toString('base64'), revised_prompt: 'revised' },
            { url: 'https://images.example/unchanged.png' },
          ],
        },
      },
      {
        id: 'b-old-gemini',
        provider: 'gemini',
        status: 'completed',
        submittedAt: NOW - 12 * DAY,
        completedAt: NOW - 10 * DAY,
        request: {
          device_id: 'device-old',
          prompt: 'old prompt',
          input_images: [existingRef, dataUrl('image/jpeg', jpeg)],
          untouched: { nested: true },
        },
        result: {
          candidates: [
            {
              finishReason: 'STOP',
              content: {
                parts: [
                  { text: 'gemini text' },
                  { inlineData: { mimeType: 'image/jpeg', data: jpeg.toString('base64') } },
                ],
              },
            },
          ],
        },
      },
      {
        id: 'c-queued',
        provider: 'openai-compat',
        status: 'queued',
        submittedAt: NOW - 3 * DAY,
        request: {
          device_id: 'device-queued',
          prompt: 'still needed upstream',
          input_images: [existingRef, dataUrl('image/png', png)],
        },
      },
    ])
    sqlite.close()

    const first = await migrateBlobs(dbPath, { now: NOW, log: () => {} })
    expect(first).toMatchObject({
      scannedTaskCount: 3,
      changedTaskCount: 3,
      inputImageCount: 3,
      outputImageCount: 2,
      droppedOutputImageCount: 1,
      blobCount: 4,
    })

    const migrated = new Database(dbPath)
    const taskRows = migrated
      .query<
        { id: string; request_payload: string; result_payload: string | null; device_id: string },
        []
      >('SELECT id, request_payload, result_payload, device_id FROM tasks ORDER BY id')
      .all()
    const requests = new Map(
      taskRows.map((row) => [row.id, JSON.parse(row.request_payload) as Record<string, unknown>]),
    )
    const results = new Map(
      taskRows.map((row) => [
        row.id,
        row.result_payload === null
          ? null
          : (JSON.parse(row.result_payload) as Record<string, unknown>),
      ]),
    )

    expect(requests.get('a-new-openai')).toEqual({
      device_id: 'device-new',
      prompt: 'keep this prompt',
      input_images: [{ $blob: 0 }],
      input_fidelity: 'high',
    })
    expect(requests.get('b-old-gemini')).toEqual({
      device_id: 'device-old',
      prompt: 'old prompt',
      input_images: [{ $blob: 0 }, { $blob: 1 }],
      untouched: { nested: true },
    })
    expect(requests.get('c-queued')).toEqual({
      device_id: 'device-queued',
      prompt: 'still needed upstream',
      input_images: [{ $blob: 0 }, { $blob: 1 }],
    })
    expect(taskRows.map((row) => row.device_id)).toEqual([
      'device-new',
      'device-old',
      'device-queued',
    ])

    const newResult = results.get('a-new-openai')!
    expect(newResult).toMatchObject({ created: 123, size: '1024x1024' })
    expect(newResult._image_meta).toEqual([
      { index: 0, mime: 'image/png', revised_prompt: 'revised' },
      { index: 1, mime: 'image/png' },
    ])
    expect((newResult.data as Array<Record<string, unknown>>)[0]).not.toHaveProperty('b64_json')
    expect((newResult.data as Array<Record<string, unknown>>)[1]).toEqual({
      url: 'https://images.example/unchanged.png',
    })

    const oldResult = results.get('b-old-gemini')!
    expect(oldResult).toMatchObject({
      _images_dropped: true,
      _image_meta: [{ index: 0, mime: 'image/jpeg', revised_prompt: 'gemini text' }],
    })
    const oldParts = (
      oldResult.candidates as Array<{ content: { parts: Array<Record<string, unknown>> } }>
    )[0]!.content.parts
    expect(oldParts[0]).toEqual({ text: 'gemini text' })
    expect(oldParts[1]!.inlineData).not.toHaveProperty('data')

    const blobs = migrated
      .query<StoredBlob, []>(`
        SELECT task_id, kind, idx, mime, data, created_at
        FROM task_blobs
        ORDER BY task_id, kind, idx
      `)
      .all()
    expect(
      blobs.map(({ task_id, kind, idx, mime, created_at }) => ({
        task_id,
        kind,
        idx,
        mime,
        created_at,
      })),
    ).toEqual([
      {
        task_id: 'a-new-openai',
        kind: 'input',
        idx: 0,
        mime: 'image/webp',
        created_at: NOW - 2 * DAY,
      },
      {
        task_id: 'a-new-openai',
        kind: 'output',
        idx: 0,
        mime: 'image/png',
        created_at: NOW - DAY,
      },
      {
        task_id: 'b-old-gemini',
        kind: 'input',
        idx: 1,
        mime: 'image/webp',
        created_at: NOW - 12 * DAY,
      },
      {
        task_id: 'c-queued',
        kind: 'input',
        idx: 1,
        mime: 'image/png',
        created_at: NOW - 3 * DAY,
      },
    ])
    expect(Buffer.from(blobs.at(-1)!.data)).toEqual(png)
    const terminalInputFormats = await Promise.all(
      blobs
        .filter((blob) => blob.kind === 'input' && blob.task_id !== 'c-queued')
        .map(async (blob) => (await sharp(blob.data).metadata()).format),
    )
    expect(terminalInputFormats).toEqual(['webp', 'webp'])
    const newOutput = blobs.find(
      (blob) => blob.task_id === 'a-new-openai' && blob.kind === 'output',
    )!
    expect(Buffer.from(newOutput.data)).toEqual(png)
    const secondSnapshot = snapshot(migrated)
    migrated.close()

    const second = await migrateBlobs(dbPath, { now: NOW, log: () => {} })
    expect(second).toMatchObject({
      scannedTaskCount: 3,
      changedTaskCount: 0,
      inputImageCount: 0,
      outputImageCount: 0,
      droppedOutputImageCount: 0,
      blobCount: 0,
    })
    const rerun = new Database(dbPath)
    expect(snapshot(rerun)).toEqual(secondSnapshot)
    rerun.close()
  })

  it('dry-run estimates both encodings without changing task data', async () => {
    const png = await sharp({
      create: { width: 1, height: 1, channels: 4, background: '#ffffff' },
    })
      .png()
      .toBuffer()
    const source = dataUrl('image/png', png)
    const resultB64 = png.toString('base64')
    const { dbPath, sqlite } = createLegacyDb([
      {
        id: 'dry-run',
        provider: 'openai-compat',
        status: 'completed',
        submittedAt: NOW,
        completedAt: NOW,
        request: { device_id: 'dry-device', input_images: [source] },
        result: { data: [{ b64_json: resultB64 }] },
      },
    ])
    const before = sqlite
      .query<{ request_payload: string; result_payload: string }, []>(
        'SELECT request_payload, result_payload FROM tasks',
      )
      .get()!
    sqlite.close()

    const stats = await migrateBlobs(dbPath, { dryRun: true, now: NOW, log: () => {} })
    expect(stats).toMatchObject({
      scannedTaskCount: 1,
      changedTaskCount: 1,
      inputImageCount: 1,
      outputImageCount: 1,
      blobCount: 2,
      encodedByteEstimate:
        Buffer.byteLength(source.split(';base64,')[1]!) + Buffer.byteLength(resultB64),
      decodedByteEstimate: png.length * 2,
    })
    const after = new Database(dbPath)
    expect(after.query('SELECT request_payload, result_payload FROM tasks').get()).toEqual(before)
    const blobTable = after
      .query<{ count: number }, []>(
        `SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'task_blobs'`,
      )
      .get()
    expect(blobTable?.count).toBe(0)
    after.close()
  })
})
