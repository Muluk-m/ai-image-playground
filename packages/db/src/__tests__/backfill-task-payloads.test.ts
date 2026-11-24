import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { backfillTaskPayloads, verifyTaskPayloadsConsistency } from '../backfill-task-payloads'
import { createDb, schema } from '../client'
import { resetTestDatabase } from '../testing'

const databaseUrl = await resetTestDatabase('db_backfill_task_payloads')
const handle = createDb(databaseUrl)

beforeEach(async () => {
  await handle.db.delete(schema.tasks)
})

afterAll(async () => {
  await handle.close()
})

function sampleTask(id: string, prompt: string) {
  return {
    id,
    provider: 'openai-compat' as const,
    model: 'gpt-image-2',
    status: 'completed' as const,
    request_payload: { prompt, device_id: 'dev-backfill' },
    metering: { mode: 'credits' as const, model: 'gpt-image-2', quantity: 1, unitMultiplier: 1 },
    result_payload: { images: [{ index: 0, key: `${id}/0.png` }] },
    archive_payload: { source: `spool/${id}` },
    upstream_body: `diag-${id}`,
    submitted_at: 1_790_000_000_000,
  }
}

describe('backfillTaskPayloads', () => {
  it('backfills missing task_payloads rows in keyset batches and is idempotent', async () => {
    const rows = Array.from({ length: 7 }, (_, i) =>
      sampleTask(`task-${String(i).padStart(2, '0')}`, `prompt-${i}`),
    )
    await handle.db.insert(schema.tasks).values(rows)

    const before = await verifyTaskPayloadsConsistency(handle.client)
    expect(before).toMatchObject({
      totalTasks: 7,
      totalPayloads: 0,
      missingCount: 7,
      mismatchCount: 0,
    })

    const progress: number[] = []
    const first = await backfillTaskPayloads(handle.client, {
      batchSize: 3,
      delayMs: 0,
      onBatch: (batch) => progress.push(batch.written),
    })
    expect(first).toEqual({
      batches: 3,
      scanned: 7,
      written: 7,
      lastId: 'task-06',
      completed: true,
    })
    expect(progress).toEqual([3, 3, 1])

    const after = await verifyTaskPayloadsConsistency(handle.client)
    expect(after).toEqual({
      totalTasks: 7,
      totalPayloads: 7,
      missingCount: 0,
      mismatchCount: 0,
      sampleMissingIds: [],
      sampleMismatchIds: [],
    })

    // Re-running inserts zero duplicate rows and preserves parity.
    const second = await backfillTaskPayloads(handle.client, { batchSize: 3, delayMs: 0 })
    expect(second).toMatchObject({ scanned: 7, written: 0, completed: true })
  })

  it('resumes bounded maxBatches slices via afterId until every row is backfilled', async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      sampleTask(`slice-${String(i).padStart(2, '0')}`, `prompt-${i}`),
    )
    await handle.db.insert(schema.tasks).values(rows)

    const slice1 = await backfillTaskPayloads(handle.client, {
      batchSize: 2,
      maxBatches: 1,
      delayMs: 0,
    })
    expect(slice1).toEqual({
      batches: 1,
      scanned: 2,
      written: 2,
      lastId: 'slice-01',
      completed: false,
    })

    const slice2 = await backfillTaskPayloads(handle.client, {
      batchSize: 2,
      maxBatches: 1,
      afterId: slice1.lastId,
      delayMs: 0,
    })
    expect(slice2).toEqual({
      batches: 1,
      scanned: 2,
      written: 2,
      lastId: 'slice-03',
      completed: false,
    })

    const slice3 = await backfillTaskPayloads(handle.client, {
      batchSize: 2,
      maxBatches: 2,
      afterId: slice2.lastId,
      delayMs: 0,
    })
    expect(slice3).toEqual({
      batches: 1,
      scanned: 1,
      written: 1,
      lastId: 'slice-04',
      completed: true,
    })

    expect(await verifyTaskPayloadsConsistency(handle.client)).toMatchObject({
      totalTasks: 5,
      totalPayloads: 5,
      missingCount: 0,
      mismatchCount: 0,
    })
  })

  it('preserves existing task_payloads rows by default and repairs drift when repairMismatches is set', async () => {
    await handle.db.insert(schema.tasks).values([sampleTask('task-a', 'fresh-prompt')])
    await handle.db.insert(schema.task_payloads).values({
      task_id: 'task-a',
      request_payload: { prompt: 'stale-prompt', device_id: 'dev-backfill' },
      metering: null,
      result_payload: null,
      archive_payload: null,
      upstream_body: 'stale-body',
    })

    const insertOnly = await backfillTaskPayloads(handle.client, { batchSize: 10, delayMs: 0 })
    expect(insertOnly).toMatchObject({ scanned: 1, written: 0, completed: true })

    const drift = await verifyTaskPayloadsConsistency(handle.client)
    expect(drift).toMatchObject({
      missingCount: 0,
      mismatchCount: 1,
      sampleMismatchIds: ['task-a'],
    })

    const repaired = await backfillTaskPayloads(handle.client, {
      batchSize: 10,
      delayMs: 0,
      repairMismatches: true,
    })
    expect(repaired).toMatchObject({ scanned: 1, written: 1, completed: true })

    const clean = await verifyTaskPayloadsConsistency(handle.client)
    expect(clean).toMatchObject({ missingCount: 0, mismatchCount: 0 })

    // Deleting a task cascades cleanly to task_payloads.
    await handle.db.delete(schema.tasks).where(eq(schema.tasks.id, 'task-a'))
    const afterDelete = await verifyTaskPayloadsConsistency(handle.client)
    expect(afterDelete).toMatchObject({ totalTasks: 0, totalPayloads: 0 })

    // Re-running repair on already-consistent rows writes zero rows.
    await handle.db.insert(schema.tasks).values([sampleTask('task-b', 'clean-prompt')])
    await backfillTaskPayloads(handle.client, { batchSize: 10, delayMs: 0 })
    const cleanRepair = await backfillTaskPayloads(handle.client, {
      batchSize: 10,
      delayMs: 0,
      repairMismatches: true,
    })
    expect(cleanRepair).toMatchObject({ scanned: 1, written: 0, completed: true })

    await expect(verifyTaskPayloadsConsistency(handle.client, -1)).rejects.toThrow(RangeError)
    expect(await verifyTaskPayloadsConsistency(handle.client, 0)).toMatchObject({
      totalTasks: 1,
      totalPayloads: 1,
      missingCount: 0,
      mismatchCount: 0,
      sampleMissingIds: [],
      sampleMismatchIds: [],
    })
  })
})
