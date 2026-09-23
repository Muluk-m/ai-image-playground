import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'

process.env.DATABASE_URL = await resetTestDatabase('bff_execution_ownership')
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
process.env.PORT = '0'
const { runPrivateMigrations } = await import('../../lib/private-overlay')
await runPrivateMigrations(process.env.DATABASE_URL)
const { db, schema, close } = await import('../../db/client')
const { recoverAbandonedTasks } = await import('../../db/maintenance')
const { claimTaskExecution } = await import('../../workers/task-execution')
const {
  AGENT_EXECUTION_LEASE_MS,
  ConversationExecutionLost,
  claimConversation,
  conversationExecution,
  releaseConversation,
  withConversationExecution,
} = await import('../../lib/agent/execution')

beforeEach(async () => {
  await db.delete(schema.tasks)
  await db.delete(schema.agent_conversations)
  await db.delete(schema.deployment_controls)
})
afterAll(close)

async function task(id: string, values: Partial<typeof schema.tasks.$inferInsert> = {}) {
  await db.insert(schema.tasks).values({
    id,
    provider: 'openai-compat',
    model: 'test',
    status: 'in_progress',
    request_payload: { prompt: 'test' },
    submitted_at: Date.now(),
    started_at: Date.now(),
    ...values,
  })
}
async function conversation() {
  await db.insert(schema.agent_conversations).values({
    id: 'conversation',
    device_id: 'fixture-device',
    title: '',
    created_at: Date.now(),
    updated_at: Date.now(),
  })
}

describe('durable execution ownership', () => {
  it('recovers a recent expired lease and leaves an old but live owner alone', async () => {
    await task('expired', {
      execution_token: 'old-owner',
      lease_expires_at: Date.now() - 1,
      upstream_task_ids: ['upstream-known'],
      upstream_invocation_count: 1,
    })
    await task('live', {
      execution_token: 'other-owner',
      lease_expires_at: Date.now() + 60_000,
      started_at: 1,
    })
    expect(await recoverAbandonedTasks()).toEqual({ requeued: 0, failed: 0, resumedPolling: 1 })
    const rows = await db.select().from(schema.tasks)
    expect(rows.find((row) => row.id === 'expired')).toMatchObject({
      status: 'queued',
      upstream_task_ids: ['upstream-known'],
      upstream_invocation_count: 1,
    })
    expect(rows.find((row) => row.id === 'live')?.status).toBe('in_progress')
  })

  it('never resubmits an unknown dispatched request after owner loss', async () => {
    await task('unknown', {
      execution_token: 'gone',
      lease_expires_at: Date.now() - 1,
      upstream_invocation_count: 1,
    })
    expect(await recoverAbandonedTasks()).toEqual({ requeued: 0, failed: 1, resumedPolling: 0 })
    const [row] = await db.select().from(schema.tasks)
    expect(row).toMatchObject({
      status: 'failed',
      error_type: 'upstream_result_unknown',
      upstream_invocation_count: 1,
    })
  })

  it('protects a live chat while recovering its lost image executor', async () => {
    await conversation()
    await claimConversation('conversation', 'turn')
    const association = {
      agent_conversation_id: 'conversation',
      agent_turn_id: 'turn',
      started_at: 1,
    }
    await task('chat', { ...association, kind: 'chat' })
    await task('image', {
      ...association,
      execution_token: 'gone',
      lease_expires_at: Date.now() - 1,
      upstream_task_ids: ['known-image'],
    })
    expect(await recoverAbandonedTasks()).toEqual({ requeued: 0, failed: 0, resumedPolling: 1 })
    const [chat] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, 'chat'))
    expect(chat?.status).toBe('in_progress')
  })

  it('grants one conversation admission across competing BFFs', async () => {
    await conversation()
    const won = await Promise.all([
      claimConversation('conversation', 'one'),
      claimConversation('conversation', 'two'),
    ])
    expect(won.filter(Boolean)).toHaveLength(1)
    await releaseConversation('conversation', won[0] ? 'one' : 'two')
    expect(await claimConversation('conversation', 'next')).toBe(true)
  })

  it('lets a new executor take over after the previous conversation heartbeat expires', async () => {
    await conversation()
    expect(await claimConversation('conversation', 'lost-turn')).toBe(true)
    await db
      .update(schema.agent_executions)
      .set({ heartbeat_at: Date.now() - AGENT_EXECUTION_LEASE_MS - 1 })
      .where(eq(schema.agent_executions.conversation_id, 'conversation'))

    expect(await conversationExecution('conversation')).toBeUndefined()
    expect(await claimConversation('conversation', 'replacement-turn')).toBe(true)
    expect(await conversationExecution('conversation')).toMatchObject({
      turn_id: 'replacement-turn',
      state: 'running',
    })
    await expect(
      withConversationExecution('conversation', 'lost-turn', async () => undefined),
    ).rejects.toBeInstanceOf(ConversationExecutionLost)
  })

  it('stops legacy admission without interrupting its active tasks or blocking a fenced worker', async () => {
    await task('active-legacy')
    await task('waiting', { status: 'queued' })
    await db
      .insert(schema.deployment_controls)
      .values({ key: 'legacy_claims_disabled', enabled: true })
    const oldClaim = await db
      .update(schema.tasks)
      .set({ status: 'in_progress' })
      .where(eq(schema.tasks.id, 'waiting'))
      .returning()
    expect(oldClaim).toHaveLength(0)
    const fenced = await claimTaskExecution('waiting')
    expect(fenced).not.toBeNull()
    fenced!.release()
    const [oldTask] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, 'active-legacy'))
    expect(oldTask?.status).toBe('in_progress')
  })
})
