import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { verifyTaskPayloadsConsistency } from '@image-playground/db'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'

const TEST_DB = await resetTestDatabase('bff_task_payloads_dual_write')

process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
process.env.DATABASE_URL = TEST_DB
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../../quota-operator-config.json')

await import('../../../app')
const { close: closeDb, db, schema } = await import('../../../db/client')
const {
  createQueueTask,
  finishTask,
  heldBy,
  requeueTask,
  requeueTaskArchive,
  requeueTasksForPolling,
  saveArchiveCheckpoint,
} = await import('../../../modules/execution')
const { claimTaskExecution } = await import('../../../workers/task-execution')

const TOKEN = 'dual-write-worker-token'

beforeEach(async () => {
  await db.delete(schema.generation_commands)
  await db.delete(schema.daily_quota)
  await db.delete(schema.tasks)
})

afterAll(async () => {
  await closeDb()
})

async function readPayload(taskId: string) {
  const [row] = await db
    .select()
    .from(schema.task_payloads)
    .where(eq(schema.task_payloads.task_id, taskId))
  return row
}

describe('task_payloads same-transaction dual-write', () => {
  it('mirrors queue submission, degrade merge, archive checkpoint, requeue, and completion into task_payloads', async () => {
    const submitted = await createQueueTask({
      entry: 'web-direct',
      provider: 'openai-compat',
      model: 'gpt-image-2',
      request: {
        prompt: 'a clean studio teapot',
        device_id: 'dual-write-device',
        n: 1,
      },
      userId: null,
    })
    expect(submitted.kind).toBe('created')
    if (submitted.kind !== 'created') throw new Error('expected created')
    const taskId = submitted.taskId

    const initialPayload = await readPayload(taskId)
    expect(initialPayload).toMatchObject({
      task_id: taskId,
      request_payload: expect.objectContaining({ prompt: 'a clean studio teapot' }),
      result_payload: null,
      archive_payload: null,
      upstream_body: null,
    })

    const execution = await claimTaskExecution(taskId)
    expect(execution).not.toBeNull()
    try {
      await execution!.recordImage26Degrade({
        kind: 'sub2api_tier',
        fields: [{ field: 'quality', from: 'high', to: 'medium' }],
      })
      expect((await readPayload(taskId))?.request_payload).toMatchObject({
        prompt: 'a clean studio teapot',
        image26_degrade: {
          kind: 'sub2api_tier',
          fields: [{ field: 'quality', from: 'high', to: 'medium' }],
        },
      })

      expect(await execution!.saveCheckpoint({ source: 'spool/teapot.png' })).toBe(true)
      expect((await readPayload(taskId))?.archive_payload).toEqual({ source: 'spool/teapot.png' })

      expect(
        await execution!.finish({
          status: 'completed',
          completedAt: Date.now(),
          attemptCount: 1,
          resultPayload: { images: [{ index: 0, key: `${taskId}/0.png` }] },
          upstreamBody: null,
        }),
      ).toBe(true)
    } finally {
      execution?.release()
    }

    expect(await readPayload(taskId)).toMatchObject({
      task_id: taskId,
      archive_payload: null,
      result_payload: { images: [{ index: 0, key: `${taskId}/0.png` }] },
    })
    expect(await verifyTaskPayloadsConsistency(db.$client)).toMatchObject({
      totalTasks: 1,
      totalPayloads: 1,
      missingCount: 0,
      mismatchCount: 0,
    })
  })

  it('backfills pre-existing tasks rows on update and clears transient fields on requeue', async () => {
    const now = Date.now()
    // Simulate a task created by an older container before PR-5.2 rolled out (no task_payloads row yet).
    await db.insert(schema.tasks).values([
      {
        id: 'legacy-requeue-1',
        provider: 'openai-compat',
        model: 'gpt-image-2',
        status: 'in_progress',
        request_payload: { prompt: 'legacy one', device_id: 'legacy-dev' },
        metering: { mode: 'credits', model: 'gpt-image-2', quantity: 1, unitMultiplier: 1 },
        result_payload: { stale: true },
        upstream_body: '502 bad gateway',
        execution_token: TOKEN,
        lease_expires_at: now + 60_000,
        submitted_at: now - 10_000,
        started_at: now - 5_000,
      },
      {
        id: 'legacy-poll-2',
        provider: 'openai-compat',
        model: 'gpt-image-2',
        status: 'in_progress',
        request_payload: { prompt: 'legacy two', device_id: 'legacy-dev' },
        metering: { mode: 'none', model: 'gpt-image-2', quantity: 1, unitMultiplier: 1 },
        upstream_body: 'transient timeout',
        execution_token: TOKEN,
        lease_expires_at: now + 60_000,
        submitted_at: now - 10_000,
        started_at: now - 5_000,
      },
    ])

    expect(await saveArchiveCheckpoint('legacy-requeue-1', { step: 1 }, heldBy(TOKEN))).toBe(true)
    expect(await readPayload('legacy-requeue-1')).toMatchObject({
      task_id: 'legacy-requeue-1',
      request_payload: { prompt: 'legacy one', device_id: 'legacy-dev' },
      archive_payload: { step: 1 },
    })

    expect(await requeueTask('legacy-requeue-1', 1, now + 5_000, heldBy(TOKEN))).toBe(true)
    expect(await readPayload('legacy-requeue-1')).toMatchObject({
      result_payload: null,
      upstream_body: null,
    })

    expect(await requeueTasksForPolling(['legacy-poll-2'], heldBy(TOKEN))).toBe(1)
    expect(await readPayload('legacy-poll-2')).toMatchObject({
      request_payload: { prompt: 'legacy two', device_id: 'legacy-dev' },
      upstream_body: null,
    })

    // Re-claim legacy-requeue-1 directly and test requeueTaskArchive + finishTask(preserveArchive: true)
    await db
      .update(schema.tasks)
      .set({ status: 'in_progress', execution_token: TOKEN, lease_expires_at: now + 60_000 })
      .where(eq(schema.tasks.id, 'legacy-requeue-1'))
    expect(
      await requeueTaskArchive('legacy-requeue-1', now + 5_000, { step: 2 }, heldBy(TOKEN)),
    ).toBe(true)
    expect((await readPayload('legacy-requeue-1'))?.archive_payload).toEqual({ step: 2 })

    await db
      .update(schema.tasks)
      .set({ status: 'in_progress', execution_token: TOKEN, lease_expires_at: now + 60_000 })
      .where(eq(schema.tasks.id, 'legacy-requeue-1'))
    expect(
      await finishTask(
        'legacy-requeue-1',
        {
          status: 'failed',
          completedAt: now,
          upstreamBody: 'upstream 500 body',
          preserveArchive: true,
        },
        heldBy(TOKEN),
      ),
    ).toBe(true)
    expect(await readPayload('legacy-requeue-1')).toMatchObject({
      archive_payload: { step: 2 },
      upstream_body: 'upstream 500 body',
    })

    expect(await verifyTaskPayloadsConsistency(db.$client)).toMatchObject({
      totalTasks: 2,
      totalPayloads: 2,
      missingCount: 0,
      mismatchCount: 0,
    })
  })
})
