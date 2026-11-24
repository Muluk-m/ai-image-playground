import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'

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
  findAccessibleTaskInput,
  findAccessibleTaskOutput,
  findAccessibleTaskResult,
  findAccessibleTaskSourceVideo,
  findAccessibleTaskStatus,
  finishTask,
  heldBy,
} = await import('../../../modules/execution')
const { reconcileAgentBatchProgress } = await import(
  '../../../modules/agent/orchestration/batch/progress'
)
const { selectRunnableTasks } = await import('../../../workers/runnable-tasks')
const { claimTaskExecution } = await import('../../../workers/task-execution')

beforeEach(async () => {
  await db.delete(schema.agent_batch_attempts)
  await db.delete(schema.agent_batch_items)
  await db.delete(schema.agent_batch_plans)
  await db.delete(schema.agent_batches)
  await db.delete(schema.agent_conversations)
  await db.delete(schema.user_changes)
  await db.delete(schema.user_change_heads)
  await db.delete(schema.generation_records)
  await db.delete(schema.tasks)
  await db.delete(schema.users)
})

afterAll(async () => {
  await closeDb()
})

describe('task_payloads switch-read with legacy fallback', () => {
  it('prefers task_payloads (including explicit NULL overrides) and falls back to tasks when unbackfilled', async () => {
    const now = Date.now()
    await db.insert(schema.tasks).values([
      {
        id: 't-new',
        provider: 'openai-compat',
        model: 'gpt-image-2',
        status: 'completed',
        request_payload: { prompt: 'stale request', device_id: 'dev-1' },
        metering: { mode: 'credits', model: 'gpt-image-2', quantity: 1, unitMultiplier: 1 },
        result_payload: { data: [{ b64_json: 'stale' }] },
        archive_payload: { stale: true },
        upstream_body: 'stale body',
        submitted_at: now - 2_000,
        completed_at: now - 1_000,
      },
      {
        id: 't-legacy',
        provider: 'openai-compat',
        model: 'gpt-image-2',
        status: 'completed',
        request_payload: { prompt: 'legacy request', device_id: 'dev-1' },
        metering: { mode: 'none', model: 'gpt-image-2', quantity: 1, unitMultiplier: 1 },
        result_payload: { data: [{ b64_json: 'legacy-b64' }] },
        archive_payload: { legacy: true },
        upstream_body: 'legacy body',
        submitted_at: now - 2_000,
        completed_at: now - 1_000,
      },
    ])
    await db.insert(schema.task_payloads).values({
      task_id: 't-new',
      request_payload: { prompt: 'fresh request', device_id: 'dev-1' },
      metering: { mode: 'none', model: 'gpt-image-2', quantity: 1, unitMultiplier: 1 },
      result_payload: { data: [{ b64_json: 'fresh-b64' }] },
      archive_payload: null,
      upstream_body: null,
    })

    const statusNew = await findAccessibleTaskStatus('t-new', null)
    expect(statusNew).toMatchObject({
      request_payload: { prompt: 'fresh request', device_id: 'dev-1' },
      result_payload: { data: [{ b64_json: 'fresh-b64' }] },
      // Explicit NULL in task_payloads must NOT fall back to stale tasks.archive_payload.
      archive_payload: null,
    })

    const statusLegacy = await findAccessibleTaskStatus('t-legacy', null)
    expect(statusLegacy).toMatchObject({
      request_payload: { prompt: 'legacy request', device_id: 'dev-1' },
      result_payload: { data: [{ b64_json: 'legacy-b64' }] },
      archive_payload: { legacy: true },
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

    // Explicit NULL result_payload in task_payloads overrides non-null tasks.result_payload.
    await db
      .update(schema.task_payloads)
      .set({ result_payload: null })
      .where(eq(schema.task_payloads.task_id, 't-new'))
    expect((await findAccessibleTaskOutput('t-new', null))?.result_payload).toBeNull()
  })

  it('overlays task_payloads in claimTaskExecution and respects archive_payload in selectRunnableTasks', async () => {
    const now = Date.now()
    await db.insert(schema.tasks).values([
      {
        id: 'run-cleared-archive',
        provider: 'openai-compat',
        model: 'gpt-image-2',
        status: 'queued',
        request_payload: { prompt: 'old', device_id: 'dev-1' },
        metering: { mode: 'credits', model: 'gpt-image-2', quantity: 1, unitMultiplier: 1 },
        archive_payload: { stale: true },
        submitted_at: now - 3_000,
      },
      {
        id: 'run-archived-in-payload',
        provider: 'openai-compat',
        model: 'gpt-image-2',
        status: 'queued',
        request_payload: { prompt: 'old2', device_id: 'dev-1' },
        archive_payload: null,
        submitted_at: now - 2_000,
      },
      {
        id: 'run-legacy-archived',
        provider: 'openai-compat',
        model: 'gpt-image-2',
        status: 'queued',
        request_payload: { prompt: 'legacy', device_id: 'dev-1' },
        archive_payload: { legacy: true },
        submitted_at: now - 1_000,
      },
    ])
    await db.insert(schema.task_payloads).values([
      {
        task_id: 'run-cleared-archive',
        request_payload: { prompt: 'from-payload', device_id: 'dev-1' },
        metering: { mode: 'none', model: 'gpt-image-2', quantity: 1, unitMultiplier: 1 },
        archive_payload: null,
      },
      {
        task_id: 'run-archived-in-payload',
        request_payload: { prompt: 'archived-payload', device_id: 'dev-1' },
        archive_payload: { checkpoint: 1 },
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

  it('uses task_payloads with fallback in publishGenerations and cancelTasks', async () => {
    const now = Date.now()
    await db.insert(schema.users).values({
      id: 'u-read-test',
      username: 'u-read-test@example.com',
      password_hash: 'fixture-hash',
      created_at: now,
      updated_at: now,
    })
    await db.insert(schema.tasks).values([
      {
        id: 'gen-from-payload',
        user_id: 'u-read-test',
        provider: 'openai-compat',
        model: 'gpt-image-2',
        status: 'queued',
        request_payload: {
          prompt: 'stale candidate',
          device_id: 'dev-1',
          output_retention: 'candidate',
        },
        metering: { mode: 'credits', model: 'gpt-image-2', quantity: 1, unitMultiplier: 1 },
        archive_payload: { stale: true },
        submitted_at: now - 2_000,
      },
      {
        id: 'gen-legacy',
        user_id: 'u-read-test',
        provider: 'openai-compat',
        model: 'gpt-image-2',
        status: 'queued',
        request_payload: { prompt: 'legacy studio', device_id: 'dev-1', size: '1024x1024' },
        metering: { mode: 'none', model: 'gpt-image-2', quantity: 1, unitMultiplier: 1 },
        archive_payload: { pending: true },
        submitted_at: now - 1_000,
      },
    ])
    await db.insert(schema.task_payloads).values({
      task_id: 'gen-from-payload',
      request_payload: {
        prompt: 'fresh canvas prompt',
        device_id: 'dev-1',
        output_retention: 'canvas',
        size: '1536x1024',
      },
      metering: { mode: 'none', model: 'gpt-image-2', quantity: 1, unitMultiplier: 1 },
      result_payload: { size: '1536x1024' },
      archive_payload: null,
    })

    await db.transaction((tx) => publishGenerations(tx, ['gen-from-payload', 'gen-legacy']))
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
        id: 'gen-legacy',
        prompt: 'legacy studio',
        archive_status: 'pending',
        parameters: { size: '1024x1024' },
        source: { kind: 'studio' },
      },
    ])

    // cancelTasks resolves metering.mode === 'none' from task_payloads so no billing hold is needed.
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
    await db.insert(schema.tasks).values({
      id: 'finish-from-payload',
      user_id: 'u-finish-test',
      provider: 'openai-compat',
      model: 'gpt-image-2',
      status: 'in_progress',
      request_payload: { prompt: 'stale request', device_id: 'dev-1' },
      metering: { mode: 'credits', model: 'gpt-image-2', quantity: 1, unitMultiplier: 1 },
      archive_payload: { stale: true },
      execution_token: token,
      lease_expires_at: now + 60_000,
      submitted_at: now - 2_000,
      started_at: now - 1_000,
    })
    await db.insert(schema.task_payloads).values({
      task_id: 'finish-from-payload',
      request_payload: {
        prompt: 'fresh request from cold table',
        device_id: 'dev-1',
        quality: 'medium',
      },
      metering: { mode: 'none', model: 'gpt-image-2', quantity: 1, unitMultiplier: 1 },
      archive_payload: { step: 1 },
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
    await db.insert(schema.tasks).values([
      {
        id: 'batch-task-cold',
        user_id: 'u-batch-test',
        provider: 'openai-compat',
        model: 'gpt-image-2',
        status: 'completed',
        request_payload: { prompt: 'cold result', device_id: 'dev-1' },
        result_payload: null,
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
        result_payload: { data: [{ b64_json: 'stale-b64' }] },
        submitted_at: now - 2_000,
        completed_at: now - 1_000,
      },
    ])
    await db.insert(schema.task_payloads).values([
      {
        task_id: 'batch-task-cold',
        request_payload: { prompt: 'cold result', device_id: 'dev-1' },
        result_payload: { data: [{ b64_json: 'fresh-batch-b64' }] },
      },
      {
        task_id: 'batch-task-cleared',
        request_payload: { prompt: 'cleared result', device_id: 'dev-1' },
        result_payload: null,
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
    expect(byKey.get('cleared-cold')?.errorCode).toBe('upstream_no_image')
  })
})
