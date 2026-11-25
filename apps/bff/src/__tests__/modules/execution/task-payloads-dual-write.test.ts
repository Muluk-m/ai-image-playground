import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { insertTestTasks, resetTestDatabase } from '@image-playground/db/testing'
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

describe('task_payloads single-write contract (Contract 1a)', () => {
  it('writes cold payloads exclusively to task_payloads and keeps tasks cold columns NULL', async () => {
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

    const [taskRow] = await db
      .select({ device_id: schema.tasks.device_id })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
    expect(taskRow?.device_id).toBe('dual-write-device')

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

    // Contract 1a guarantee: runtime code never writes to the 5 deprecated cold columns on tasks.
    const [legacyCols] = await db.$client<
      {
        request_payload: unknown
        metering: unknown
        result_payload: unknown
        archive_payload: unknown
        upstream_body: string | null
      }[]
    >`
      SELECT request_payload, metering, result_payload, archive_payload, upstream_body
      FROM tasks
      WHERE id = ${taskId}
    `
    expect(legacyCols).toEqual({
      request_payload: null,
      metering: null,
      result_payload: null,
      archive_payload: null,
      upstream_body: null,
    })
  })

  it('updates task_payloads in place and clears transient fields on requeue', async () => {
    const now = Date.now()
    await insertTestTasks(db, [
      {
        id: 'requeue-1',
        provider: 'openai-compat',
        model: 'gpt-image-2',
        status: 'in_progress',
        request_payload: { prompt: 'one', device_id: 'dev-1' },
        metering: { mode: 'credits', model: 'gpt-image-2', quantity: 1, unitMultiplier: 1 },
        result_payload: { stale: true },
        upstream_body: '502 bad gateway',
        execution_token: TOKEN,
        lease_expires_at: now + 60_000,
        submitted_at: now - 10_000,
        started_at: now - 5_000,
      },
      {
        id: 'poll-2',
        provider: 'openai-compat',
        model: 'gpt-image-2',
        status: 'in_progress',
        request_payload: { prompt: 'two', device_id: 'dev-1' },
        metering: { mode: 'none', model: 'gpt-image-2', quantity: 1, unitMultiplier: 1 },
        upstream_body: 'transient timeout',
        execution_token: TOKEN,
        lease_expires_at: now + 60_000,
        submitted_at: now - 10_000,
        started_at: now - 5_000,
      },
    ])

    expect(await saveArchiveCheckpoint('requeue-1', { step: 1 }, heldBy(TOKEN))).toBe(true)
    expect(await readPayload('requeue-1')).toMatchObject({
      task_id: 'requeue-1',
      request_payload: { prompt: 'one', device_id: 'dev-1' },
      archive_payload: { step: 1 },
    })

    expect(await requeueTask('requeue-1', 1, now + 5_000, heldBy(TOKEN))).toBe(true)
    expect(await readPayload('requeue-1')).toMatchObject({
      result_payload: null,
      upstream_body: null,
    })

    expect(await requeueTasksForPolling(['poll-2'], heldBy(TOKEN))).toBe(1)
    expect(await readPayload('poll-2')).toMatchObject({
      request_payload: { prompt: 'two', device_id: 'dev-1' },
      upstream_body: null,
    })

    await db
      .update(schema.tasks)
      .set({ status: 'in_progress', execution_token: TOKEN, lease_expires_at: now + 60_000 })
      .where(eq(schema.tasks.id, 'requeue-1'))
    expect(await requeueTaskArchive('requeue-1', now + 5_000, { step: 2 }, heldBy(TOKEN))).toBe(
      true,
    )
    expect((await readPayload('requeue-1'))?.archive_payload).toEqual({ step: 2 })

    await db
      .update(schema.tasks)
      .set({ status: 'in_progress', execution_token: TOKEN, lease_expires_at: now + 60_000 })
      .where(eq(schema.tasks.id, 'requeue-1'))
    expect(
      await finishTask(
        'requeue-1',
        {
          status: 'failed',
          completedAt: now,
          upstreamBody: 'upstream 500 body',
          preserveArchive: true,
        },
        heldBy(TOKEN),
      ),
    ).toBe(true)
    expect(await readPayload('requeue-1')).toMatchObject({
      archive_payload: { step: 2 },
      upstream_body: 'upstream 500 body',
    })
  })
})
