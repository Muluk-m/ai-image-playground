import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { insertTestTasks, resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'
import sharp from 'sharp'
import { InMemoryObjectStore } from '../../helpers/inMemoryObjectStore'

const TEST_DB = await resetTestDatabase('bff_task_payloads_read')

process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
process.env.DATABASE_URL = TEST_DB
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../../quota-operator-config.json')

await import('../../../app')
const { close: closeDb, db, schema } = await import('../../../db/client')
const { publishGenerations } = await import('../../../db/generation-events')
const {
  awaitQueueTask,
  cancelTasks,
  createQueueTask,
  findAccessibleTaskInput,
  findAccessibleTaskOutput,
  findAccessibleTaskResult,
  findAccessibleTaskSourceVideo,
  findAccessibleTaskStatus,
  finishTask,
  heldBy,
  requeueTask,
  requeueTaskArchive,
  requeueTasksForPolling,
  saveArchiveCheckpoint,
} = await import('../../../modules/execution')
const { reconcileAgentBatchProgress } = await import(
  '../../../modules/agent/orchestration/batch/progress'
)
const { setDurableMediaStoreForTesting } = await import('../../../lib/durableMediaStore')
const { listGenerations, readGeneration } = await import('../../../lib/generations')
const { setObjectStoreForTesting } = await import('../../../lib/objectStore')
const { promoteCanvasCandidate } = await import('../../../lib/promoteCanvasCandidate')
const { selectRunnableTasks } = await import('../../../workers/runnable-tasks')
const { claimTaskExecution } = await import('../../../workers/task-execution')

beforeEach(async () => {
  await db.delete(schema.agent_batch_attempts)
  await db.delete(schema.agent_batch_items)
  await db.delete(schema.agent_batch_plans)
  await db.delete(schema.agent_batches)
  await db.delete(schema.agent_conversations)
  await db.delete(schema.media_references)
  await db.delete(schema.generation_images)
  await db.delete(schema.user_changes)
  await db.delete(schema.user_change_heads)
  await db.delete(schema.generation_records)
  await db.delete(schema.tasks)
  await db.delete(schema.media_objects)
  await db.delete(schema.users)
})

afterAll(async () => {
  setDurableMediaStoreForTesting(undefined)
  setObjectStoreForTesting(undefined)
  await closeDb()
})

describe('task_payloads direct reads and partial updates (Contract 1a)', () => {
  it('reads cold columns directly from task_payloads including explicit NULLs', async () => {
    const now = Date.now()
    await insertTestTasks(db, {
      id: 't-new',
      provider: 'openai-compat',
      model: 'gpt-image-2',
      status: 'completed',
      request_payload: { prompt: 'fresh request', device_id: 'dev-1' },
      metering: { mode: 'none', model: 'gpt-image-2', quantity: 1, unitMultiplier: 1 },
      result_payload: { data: [{ b64_json: 'fresh-b64' }] },
      archive_payload: null,
      upstream_body: null,
      submitted_at: now - 2_000,
      completed_at: now - 1_000,
    })

    const statusNew = await findAccessibleTaskStatus('t-new', null)
    expect(statusNew).toMatchObject({
      request_payload: { prompt: 'fresh request', device_id: 'dev-1' },
      result_payload: { data: [{ b64_json: 'fresh-b64' }] },
      archive_payload: null,
    })

    expect((await findAccessibleTaskResult('t-new', null))?.request_payload).toMatchObject({
      prompt: 'fresh request',
    })
    expect((await findAccessibleTaskInput('t-new', null))?.request_payload).toMatchObject({
      prompt: 'fresh request',
    })
    expect((await findAccessibleTaskOutput('t-new', null))?.result_payload).toEqual({
      data: [{ b64_json: 'fresh-b64' }],
    })
    expect((await findAccessibleTaskSourceVideo('t-new', null))?.result_payload).toEqual({
      data: [{ b64_json: 'fresh-b64' }],
    })
    const outcome = await awaitQueueTask('t-new')
    expect(outcome.kind).toBe('completed')

    await db
      .update(schema.task_payloads)
      .set({ result_payload: null })
      .where(eq(schema.task_payloads.task_id, 't-new'))
    expect((await findAccessibleTaskOutput('t-new', null))?.result_payload).toBeNull()
  })

  it('loads task_payloads in claimTaskExecution and respects archive_payload in selectRunnableTasks', async () => {
    const now = Date.now()
    await insertTestTasks(db, [
      {
        id: 'run-cleared-archive',
        provider: 'openai-compat',
        model: 'gpt-image-2',
        status: 'queued',
        request_payload: { prompt: 'from-payload', device_id: 'dev-1' },
        metering: { mode: 'none', model: 'gpt-image-2', quantity: 1, unitMultiplier: 1 },
        archive_payload: null,
        submitted_at: now - 3_000,
      },
      {
        id: 'run-archived-in-payload',
        provider: 'openai-compat',
        model: 'gpt-image-2',
        status: 'queued',
        request_payload: { prompt: 'archived-payload', device_id: 'dev-1' },
        archive_payload: { checkpoint: 1 },
        submitted_at: now - 2_000,
      },
    ])

    const runnable = await selectRunnableTasks('openai-compat', 10, now, { excludeArchived: true })
    expect(runnable.map((r) => r.id)).toEqual(['run-cleared-archive'])

    const execution = await claimTaskExecution('run-cleared-archive', now)
    expect(execution).not.toBeNull()
    try {
      expect(execution!.task.request_payload).toEqual({
        prompt: 'from-payload',
        device_id: 'dev-1',
      })
      expect(execution!.task.metering).toEqual({
        mode: 'none',
        model: 'gpt-image-2',
        quantity: 1,
        unitMultiplier: 1,
      })
      expect(execution!.task.archive_payload).toBeNull()
    } finally {
      execution?.release()
    }
  })

  it('reads task_payloads in publishGenerations and cancelTasks', async () => {
    const now = Date.now()
    await db.insert(schema.users).values({
      id: 'u-read-test',
      username: 'u-read-test@example.com',
      password_hash: 'fixture-hash',
      created_at: now,
      updated_at: now,
    })
    await insertTestTasks(db, [
      {
        id: 'gen-from-payload',
        user_id: 'u-read-test',
        provider: 'openai-compat',
        model: 'gpt-image-2',
        status: 'queued',
        request_payload: {
          prompt: 'fresh canvas prompt',
          device_id: 'dev-1',
          output_retention: 'canvas',
          size: '1536x1024',
        },
        metering: { mode: 'none', model: 'gpt-image-2', quantity: 1, unitMultiplier: 1 },
        result_payload: { size: '1536x1024' },
        archive_payload: null,
        submitted_at: now - 2_000,
      },
      {
        id: 'gen-studio',
        user_id: 'u-read-test',
        provider: 'openai-compat',
        model: 'gpt-image-2',
        status: 'queued',
        request_payload: { prompt: 'studio prompt', device_id: 'dev-1', size: '1024x1024' },
        metering: { mode: 'none', model: 'gpt-image-2', quantity: 1, unitMultiplier: 1 },
        archive_payload: { pending: true },
        submitted_at: now - 1_000,
      },
    ])

    await db.transaction((tx) => publishGenerations(tx, ['gen-from-payload', 'gen-studio']))
    const records = await db
      .select()
      .from(schema.generation_records)
      .orderBy(schema.generation_records.id)
    expect(records).toMatchObject([
      {
        id: 'gen-from-payload',
        prompt: 'fresh canvas prompt',
        archive_status: 'none',
        parameters: { size: '1536x1024' },
        actual_parameters: { size: '1536x1024' },
        source: { kind: 'canvas' },
      },
      {
        id: 'gen-studio',
        prompt: 'studio prompt',
        archive_status: 'pending',
        parameters: { size: '1024x1024' },
        source: { kind: 'studio' },
      },
    ])

    const cancelled = await cancelTasks(eq(schema.tasks.id, 'gen-from-payload'))
    expect(cancelled).toHaveLength(1)
    expect(cancelled[0]!.metering?.mode).toBe('none')
  })

  it('preserves task_payloads metering and request_payload during finishTask without clobbering', async () => {
    const now = Date.now()
    const token = 'finish-payload-precedence-token'
    await db.insert(schema.users).values({
      id: 'u-finish-test',
      username: 'u-finish-test@example.com',
      password_hash: 'fixture-hash',
      created_at: now,
      updated_at: now,
    })
    await insertTestTasks(db, {
      id: 'finish-from-payload',
      user_id: 'u-finish-test',
      provider: 'openai-compat',
      model: 'gpt-image-2',
      status: 'in_progress',
      request_payload: {
        prompt: 'fresh request from cold table',
        device_id: 'dev-1',
        quality: 'medium',
      },
      metering: { mode: 'none', model: 'gpt-image-2', quantity: 1, unitMultiplier: 1 },
      archive_payload: { step: 1 },
      execution_token: token,
      lease_expires_at: now + 60_000,
      submitted_at: now - 2_000,
      started_at: now - 1_000,
    })

    const finished = await finishTask(
      'finish-from-payload',
      {
        status: 'completed',
        completedAt: now,
        resultPayload: { data: [{ b64_json: 'done-b64' }] },
        upstreamBody: null,
      },
      heldBy(token),
    )
    expect(finished).toBe(true)

    const [payload] = await db
      .select()
      .from(schema.task_payloads)
      .where(eq(schema.task_payloads.task_id, 'finish-from-payload'))
    expect(payload).toMatchObject({
      request_payload: {
        prompt: 'fresh request from cold table',
        device_id: 'dev-1',
        quality: 'medium',
      },
      metering: { mode: 'none', model: 'gpt-image-2', quantity: 1, unitMultiplier: 1 },
      result_payload: { data: [{ b64_json: 'done-b64' }] },
      archive_payload: null,
    })
    const [gen] = await db
      .select()
      .from(schema.generation_records)
      .where(eq(schema.generation_records.id, 'finish-from-payload'))
    expect(gen?.prompt).toBe('fresh request from cold table')
  })

  it('reads batch attempt result_payload from task_payloads (including explicit NULL) in reconcileAgentBatchProgress', async () => {
    const now = Date.now()
    const batchId = 'batch-payload-read'
    await db.insert(schema.users).values({
      id: 'u-batch-test',
      username: 'u-batch-test@example.com',
      password_hash: 'fixture-hash',
      created_at: now,
      updated_at: now,
    })
    await db.insert(schema.agent_conversations).values({
      id: batchId,
      user_id: 'u-batch-test',
      title: batchId,
      created_at: now,
      updated_at: now,
    })
    await db.insert(schema.agent_batches).values({
      id: batchId,
      user_id: 'u-batch-test',
      conversation_id: batchId,
      origin_turn_id: 'turn-1',
      tool_call_id: 'call-1',
      experience: 'chat',
      status: 'running',
      current_version: 1,
      confirmed_version: 1,
      created_at: now,
      updated_at: now,
    })
    const estimate = {
      status: 'available' as const,
      estimatedCredits: 0,
      estimatedChargeCredits: 0,
      snapshots: [],
    }
    await db.insert(schema.agent_batch_plans).values({
      batch_id: batchId,
      version: 1,
      title: batchId,
      rule: 'payload read',
      digest: 'a'.repeat(64),
      item_count: 2,
      estimate_snapshot: { analysis: estimate, generation: estimate },
      created_at: now,
    })
    await db.insert(schema.agent_batch_items).values([
      {
        batch_id: batchId,
        version: 1,
        key: 'from-cold',
        ordinal: 0,
        kind: 'generation',
        inputs: [],
        prompt: 'cold result',
        params: { model: 'gpt-image-2', provider: 'openai-compat' },
        dependencies: [],
      },
      {
        batch_id: batchId,
        version: 1,
        key: 'cleared-cold',
        ordinal: 1,
        kind: 'generation',
        inputs: [],
        prompt: 'cleared result',
        params: { model: 'gpt-image-2', provider: 'openai-compat' },
        dependencies: [],
      },
    ])
    await insertTestTasks(db, [
      {
        id: 'batch-task-cold',
        user_id: 'u-batch-test',
        provider: 'openai-compat',
        model: 'gpt-image-2',
        status: 'completed',
        request_payload: { prompt: 'cold result', device_id: 'dev-1' },
        result_payload: { data: [{ b64_json: 'fresh-batch-b64' }] },
        submitted_at: now - 2_000,
        completed_at: now - 1_000,
      },
      {
        id: 'batch-task-cleared',
        user_id: 'u-batch-test',
        provider: 'openai-compat',
        model: 'gpt-image-2',
        status: 'completed',
        request_payload: { prompt: 'cleared result', device_id: 'dev-1' },
        result_payload: null,
        submitted_at: now - 2_000,
        completed_at: now - 1_000,
      },
    ])
    await db.insert(schema.agent_batch_attempts).values([
      {
        batch_id: batchId,
        version: 1,
        item_key: 'from-cold',
        attempt: 1,
        task_id: 'batch-task-cold',
        reserved_credits: 0,
        submitted_at: now - 2_000,
      },
      {
        batch_id: batchId,
        version: 1,
        item_key: 'cleared-cold',
        attempt: 1,
        task_id: 'batch-task-cleared',
        reserved_credits: 0,
        submitted_at: now - 2_000,
      },
    ])

    await reconcileAgentBatchProgress(batchId)
    const settled = await db
      .select({
        itemKey: schema.agent_batch_attempts.item_key,
        snapshot: schema.agent_batch_attempts.terminal_snapshot,
      })
      .from(schema.agent_batch_attempts)
      .where(eq(schema.agent_batch_attempts.batch_id, batchId))
    const byKey = new Map(settled.map((row) => [row.itemKey, row.snapshot]))
    expect(byKey.get('from-cold')?.artifacts).toHaveLength(1)
    expect(byKey.get('from-cold')?.errorCode).toBeNull()
    expect(byKey.get('cleared-cold')?.artifacts).toEqual([])
    expect(byKey.get('cleared-cold')?.errorCode).toBe('no_output')
  })

  it('preserves untouched task_payloads columns across partial updates (preserveInputs, checkpoint, requeue, promoteCanvasCandidate)', async () => {
    const now = Date.now()
    const store = Object.assign(new InMemoryObjectStore(), {
      sign: (key: string) => `https://media.test/${key}`,
    })
    setObjectStoreForTesting(store)
    setDurableMediaStoreForTesting(store)
    try {
      await db.insert(schema.users).values({
        id: 'u-partial-test',
        username: 'u-partial-test@example.com',
        password_hash: 'fixture-hash',
        created_at: now,
        updated_at: now,
      })
      const png = await sharp({
        create: { width: 8, height: 8, channels: 3, background: '#224466' },
      })
        .png()
        .toBuffer()
      const pngB64 = png.toString('base64')

      await insertTestTasks(db, {
        id: 'partial-worker-1',
        user_id: 'u-partial-test',
        provider: 'openai-compat',
        model: 'gpt-image-2',
        status: 'queued',
        request_payload: { prompt: 'cold prompt', device_id: 'dev-1' },
        metering: { mode: 'none', model: 'gpt-image-2', quantity: 1, unitMultiplier: 1 },
        result_payload: { cold: true },
        upstream_body: 'cold error',
        submitted_at: now - 5_000,
      })

      const execution = await claimTaskExecution('partial-worker-1', now)
      expect(execution).not.toBeNull()
      try {
        const preserved = await execution!.preserveInputs({
          prompt: 'preserved prompt',
          device_id: 'dev-1',
        })
        expect(preserved).toEqual({ prompt: 'preserved prompt', device_id: 'dev-1' })
        const [afterPreserve] = await db
          .select()
          .from(schema.task_payloads)
          .where(eq(schema.task_payloads.task_id, 'partial-worker-1'))
        expect(afterPreserve?.metering?.mode).toBe('none')
        expect(afterPreserve?.result_payload).toEqual({ cold: true })

        expect(await execution!.saveCheckpoint({ checkpoint: 1 })).toBe(true)
        const [afterCheckpoint] = await db
          .select()
          .from(schema.task_payloads)
          .where(eq(schema.task_payloads.task_id, 'partial-worker-1'))
        expect(afterCheckpoint?.metering?.mode).toBe('none')
        expect(afterCheckpoint?.archive_payload).toEqual({ checkpoint: 1 })

        expect(await execution!.requeueArchive(now + 10_000)).toBe(true)
        const [afterRequeueArchive] = await db
          .select()
          .from(schema.task_payloads)
          .where(eq(schema.task_payloads.task_id, 'partial-worker-1'))
        expect(afterRequeueArchive?.metering?.mode).toBe('none')
        expect(afterRequeueArchive?.archive_payload).toEqual({ checkpoint: 1 })
      } finally {
        execution?.release()
      }

      const token = 'partial-requeue-token'
      await db
        .update(schema.tasks)
        .set({ status: 'in_progress', execution_token: token, lease_expires_at: now + 60_000 })
        .where(eq(schema.tasks.id, 'partial-worker-1'))
      expect(await requeueTask('partial-worker-1', 1, now + 5_000, heldBy(token))).toBe(true)
      const [afterRequeue] = await db
        .select()
        .from(schema.task_payloads)
        .where(eq(schema.task_payloads.task_id, 'partial-worker-1'))
      expect(afterRequeue).toMatchObject({
        metering: { mode: 'none', model: 'gpt-image-2', quantity: 1, unitMultiplier: 1 },
        result_payload: null,
        upstream_body: null,
        archive_payload: { checkpoint: 1 },
      })

      await db
        .update(schema.tasks)
        .set({ status: 'in_progress', execution_token: token, lease_expires_at: now + 60_000 })
        .where(eq(schema.tasks.id, 'partial-worker-1'))
      expect(
        await saveArchiveCheckpoint('partial-worker-1', { checkpoint: 2 }, heldBy(token)),
      ).toBe(true)
      expect(
        await requeueTaskArchive('partial-worker-1', now + 5_000, { checkpoint: 3 }, heldBy(token)),
      ).toBe(true)
      await db
        .update(schema.tasks)
        .set({ status: 'in_progress', execution_token: token, lease_expires_at: now + 60_000 })
        .where(eq(schema.tasks.id, 'partial-worker-1'))
      expect(await requeueTasksForPolling(['partial-worker-1'], heldBy(token))).toBe(1)
      const [afterPollRequeue] = await db
        .select()
        .from(schema.task_payloads)
        .where(eq(schema.task_payloads.task_id, 'partial-worker-1'))
      expect(afterPollRequeue?.metering?.mode).toBe('none')
      expect(afterPollRequeue?.archive_payload).toEqual({ checkpoint: 3 })

      await insertTestTasks(db, {
        id: 'partial-canvas-promote',
        user_id: 'u-partial-test',
        provider: 'openai-compat',
        model: 'gpt-image-2',
        status: 'completed',
        request_payload: {
          prompt: 'cold canvas candidate',
          device_id: 'dev-1',
          output_retention: 'candidate',
        },
        metering: { mode: 'none', model: 'gpt-image-2', quantity: 1, unitMultiplier: 1 },
        result_payload: { data: [{ b64_json: pngB64 }] },
        submitted_at: now - 3_000,
        completed_at: now - 1_000,
      })

      const promoted = await promoteCanvasCandidate('u-partial-test', 'partial-canvas-promote', 0)
      expect(promoted.ok).toBe(true)
      const [afterPromote] = await db
        .select()
        .from(schema.task_payloads)
        .where(eq(schema.task_payloads.task_id, 'partial-canvas-promote'))
      expect(afterPromote).toMatchObject({
        request_payload: {
          prompt: 'cold canvas candidate',
          device_id: 'dev-1',
          output_retention: 'canvas',
        },
        metering: { mode: 'none', model: 'gpt-image-2', quantity: 1, unitMultiplier: 1 },
        result_payload: { data: [{ b64_json: pngB64 }] },
      })

      await db
        .update(schema.generation_records)
        .set({ source: { kind: 'studio' } })
        .where(eq(schema.generation_records.id, 'partial-canvas-promote'))
      const marked = await promoteCanvasCandidate('u-partial-test', 'partial-canvas-promote', 0)
      expect(marked.ok).toBe(true)
      const [afterMark] = await db
        .select()
        .from(schema.task_payloads)
        .where(eq(schema.task_payloads.task_id, 'partial-canvas-promote'))
      expect(afterMark?.result_payload).toEqual({ data: [{ b64_json: pngB64 }] })
      expect(afterMark?.metering?.mode).toBe('none')
    } finally {
      setDurableMediaStoreForTesting(undefined)
      setObjectStoreForTesting(undefined)
    }
  })

  it('operates end-to-end with all 5 cold columns and legacy sync triggers removed by 0112 (Contract 1b)', async () => {
    const now = Date.now()
    expect(
      await db.$client`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'tasks'
          AND column_name IN (
            'request_payload',
            'metering',
            'result_payload',
            'archive_payload',
            'upstream_body'
          )
      `,
    ).toEqual([])
    expect(
      await db.$client`
        SELECT tgname
        FROM pg_trigger
        WHERE NOT tgisinternal
          AND tgname IN (
            'trg_tasks_sync_request_payload',
            'trg_tasks_sync_metering',
            'trg_tasks_sync_result_payload',
            'trg_tasks_sync_archive_payload',
            'trg_tasks_sync_upstream_body',
            'trg_tasks_fill_device_id_legacy',
            'trg_task_payloads_skip_legacy_null_insert'
          )
      `,
    ).toEqual([])

    await db.insert(schema.users).values({
      id: 'u-wave2-compat',
      username: 'u-wave2-compat@example.com',
      password_hash: 'fixture-hash',
      created_at: now,
      updated_at: now,
    })

    const created = await createQueueTask({
      entry: 'web-direct',
      provider: 'openai-compat',
      model: 'gpt-image-2',
      request: { prompt: 'zero cold column task', device_id: 'dev-w2', n: 1 },
      userId: 'u-wave2-compat',
    })
    expect(created.kind).toBe('created')
    if (created.kind !== 'created') throw new Error('expected created')
    const taskId = created.taskId

    expect(
      (await findAccessibleTaskStatus(taskId, 'u-wave2-compat'))?.request_payload,
    ).toMatchObject({ prompt: 'zero cold column task' })
    expect((await listGenerations('u-wave2-compat', 10)).items.map((i) => i.id)).toEqual([taskId])
    expect((await readGeneration('u-wave2-compat', taskId))?.prompt).toBe('zero cold column task')

    const execution = await claimTaskExecution(taskId)
    expect(execution).not.toBeNull()
    try {
      await execution!.recordImage26Degrade({
        kind: 'sub2api_tier',
        fields: [{ field: 'quality', from: 'high', to: 'medium' }],
      })
      expect(await execution!.saveCheckpoint({ source: 'spool/w2.png' })).toBe(true)
      expect(
        await execution!.finish({
          status: 'completed',
          completedAt: Date.now(),
          attemptCount: 1,
          resultPayload: { data: [{ b64_json: 'w2-done' }] },
        }),
      ).toBe(true)
    } finally {
      execution?.release()
    }

    expect((await findAccessibleTaskOutput(taskId, 'u-wave2-compat'))?.result_payload).toEqual({
      data: [{ b64_json: 'w2-done' }],
    })
    expect(
      await db.$client`SELECT id, device_id, request_payload FROM public.queue_tasks WHERE id = ${taskId}`,
    ).toEqual([
      {
        id: taskId,
        device_id: 'dev-w2',
        request_payload: expect.objectContaining({
          prompt: 'zero cold column task',
          device_id: 'dev-w2',
        }),
      },
    ])
  })
})
