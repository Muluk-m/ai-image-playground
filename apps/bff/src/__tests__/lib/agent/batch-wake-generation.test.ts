import { afterAll, beforeAll, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'

process.env.DATABASE_URL = await resetTestDatabase('bff_agent_batch_wake_generation')

const { close, db, schema } = await import('../../../db/client')
const { BATCH_WAKE_REVIEW_IMAGE_MAX, batchWakeContent } = await import(
  '../../../lib/agent/batch-wake'
)
afterAll(close)

const NOW = Date.UTC(2026, 9, 20, 6, 0, 0)
const OWNER = { kind: 'user' as const, userId: 'owner' }
const estimate = {
  status: 'available' as const,
  estimatedCredits: 0,
  estimatedChargeCredits: 0,
  snapshots: [],
}

async function seedBatch(id: string, outcomes: readonly ('completed' | 'failed')[]) {
  await db.insert(schema.agent_conversations).values({
    id,
    user_id: 'owner',
    title: id,
    created_at: NOW,
    updated_at: NOW,
  })
  await db.insert(schema.agent_batches).values({
    id,
    user_id: 'owner',
    conversation_id: id,
    origin_turn_id: 'origin',
    tool_call_id: id,
    experience: 'chat',
    status: 'closed',
    current_version: 1,
    confirmed_version: 1,
    created_at: NOW,
    updated_at: NOW,
  })
  await db.insert(schema.agent_batch_plans).values({
    batch_id: id,
    version: 1,
    title: id,
    rule: 'rule',
    digest: 'a'.repeat(64),
    item_count: outcomes.length,
    estimate_snapshot: { analysis: estimate, generation: estimate },
    created_at: NOW,
  })
  for (const [index, status] of outcomes.entries()) {
    const key = `item-${index}`
    const taskId = `${id}-task-${index}`
    await db.insert(schema.agent_batch_items).values({
      batch_id: id,
      version: 1,
      key,
      ordinal: index,
      kind: 'generation',
      inputs: [],
      prompt: 'prompt',
      params: { model: 'fixture', provider: 'openai-compat' as const },
      dependencies: [],
    })
    await db.insert(schema.tasks).values({
      id: taskId,
      user_id: 'owner',
      provider: 'openai-compat',
      model: 'fixture',
      status,
      request_payload: { device_id: 'device', prompt: 'prompt', n: 1 },
      submitted_at: NOW,
      completed_at: NOW,
    })
    await db.insert(schema.agent_batch_attempts).values({
      batch_id: id,
      version: 1,
      item_key: key,
      attempt: 1,
      task_id: taskId,
      reserved_credits: 100,
      submitted_at: NOW,
      terminal_snapshot: {
        status,
        completedAt: NOW,
        upstreamStatus: null,
        actualCredits: status === 'completed' ? 100 : 0,
        artifacts:
          status === 'completed'
            ? [
                {
                  artifactId: `agent_${taskId}_0`,
                  media: 'image' as const,
                  taskId,
                  outputIndex: 0,
                  mime: 'image/png',
                },
              ]
            : [],
        errorCode: status === 'completed' ? null : 'upstream_error',
        message: null,
      },
    })
  }
  return outcomes.map((_, index) => `item-${index}`)
}

beforeAll(async () => {
  await db.insert(schema.users).values({
    id: 'owner',
    username: 'owner',
    password_hash: 'fixture',
    status: 'active',
    created_at: NOW,
    updated_at: NOW,
  })
})

it('asks for a visual review of generation results instead of reading analysis findings', async () => {
  const itemKeys = await seedBatch('four', ['completed', 'completed', 'failed', 'completed'])
  const content = await batchWakeContent('four', OWNER, {
    batchId: 'four',
    version: 1,
    eventVersion: 1,
    itemKeys,
  })
  expect(content).not.toBeNull()
  expect(content!.optionalReviewImageIds).toEqual([
    'agent_four-task-0_0',
    'agent_four-task-1_0',
    'agent_four-task-3_0',
  ])
  expect(content!.text).toContain('逐张复核')
  expect(content!.text).not.toContain('readBatchAnalysis')
  expect(JSON.parse(content!.text.split('\n')[2]!)).toHaveLength(4)
})

it('offers only the first few results and tells the model to trust the attached list', async () => {
  const outcomes = Array.from({ length: 9 }, () => 'completed' as const)
  const itemKeys = await seedBatch('nine', outcomes)
  const content = await batchWakeContent('nine', OWNER, {
    batchId: 'nine',
    version: 1,
    eventVersion: 1,
    itemKeys,
  })
  expect(content!.optionalReviewImageIds).toHaveLength(BATCH_WAKE_REVIEW_IMAGE_MAX)
  expect(content!.text).toContain('agent_nine-task-8_0')
  expect(content!.text).toContain(`前 ${BATCH_WAKE_REVIEW_IMAGE_MAX} 张会尽量作为图片随这一轮附上`)
  expect(content!.text).toContain('清单里没有的产物如实说明尚未查看')
})
