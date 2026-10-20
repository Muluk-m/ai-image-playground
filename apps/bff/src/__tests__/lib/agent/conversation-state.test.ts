import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'

process.env.DATABASE_URL = await resetTestDatabase('bff_agent_conversation_state')

const { close, db, schema } = await import('../../../db/client')
const { CONVERSATION_STATE_WINDOW_MS, readConversationStateFacts, renderConversationState } =
  await import('../../../lib/agent/conversation-state')
afterAll(close)

const NOW = Date.UTC(2026, 9, 20, 6, 0, 0)
const estimate = {
  status: 'available' as const,
  estimatedCredits: 0,
  estimatedChargeCredits: 0,
  snapshots: [],
}

async function conversation(id: string): Promise<void> {
  await db.insert(schema.agent_conversations).values({
    id,
    user_id: 'owner',
    title: id,
    created_at: NOW,
    updated_at: NOW,
  })
}

async function draft(
  conversationId: string,
  id: string,
  prompt: string,
  at = NOW,
  taskId?: string,
) {
  await db.insert(schema.agent_generation_drafts).values({
    id,
    conversation_id: conversationId,
    turn_id: 'turn',
    tool_call_id: id,
    tool_name: 'editImage',
    media: 'image',
    provider: 'openai-compat',
    model: 'fixture',
    prompt,
    request: { prompt, device_id: 'device', n: 1 },
    submission: { review: false },
    created_at: at,
    ...(taskId ? { task_id: taskId, confirmed_at: at } : {}),
  })
}

async function batch(
  conversationId: string,
  id: string,
  status: 'draft' | 'running' | 'closed',
  tasks: readonly ('completed' | 'failed' | 'in_progress')[],
  itemCount = tasks.length || 2,
  at = NOW,
) {
  await db.insert(schema.agent_batches).values({
    id,
    user_id: 'owner',
    conversation_id: conversationId,
    origin_turn_id: 'origin',
    tool_call_id: id,
    experience: 'chat',
    status,
    current_version: 1,
    ...(status === 'draft' ? {} : { confirmed_version: 1 }),
    created_at: at,
    updated_at: at,
  })
  await db.insert(schema.agent_batch_plans).values({
    batch_id: id,
    version: 1,
    title: `计划 ${id}`,
    rule: 'rule',
    digest: 'a'.repeat(64),
    item_count: itemCount,
    estimate_snapshot: { analysis: estimate, generation: estimate },
    created_at: at,
  })
  for (const [index, taskStatus] of tasks.entries()) {
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
      status: taskStatus,
      request_payload: { device_id: 'device', prompt: 'prompt', n: 1 },
      submitted_at: at + index,
    })
    await db.insert(schema.agent_batch_attempts).values({
      batch_id: id,
      version: 1,
      item_key: key,
      attempt: 1,
      task_id: taskId,
      reserved_credits: 100,
      submitted_at: at + index,
    })
  }
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

describe('readConversationStateFacts', () => {
  it('lists unconfirmed drafts and recent batches with completed artifacts', async () => {
    await conversation('busy')
    await draft('busy', 'pending-1', '把浴缸换成图2的款式')
    await draft('busy', 'confirmed', '已经确认的那张', NOW, 'confirmed-task')
    await draft('busy', 'stale', '一天以前的稿', NOW - CONVERSATION_STATE_WINDOW_MS - 1)
    await batch('busy', 'done', 'closed', ['completed', 'completed', 'failed'])
    await batch('busy', 'waiting', 'draft', [], 4)

    await db.insert(schema.agent_messages).values([
      {
        conversation_id: 'busy',
        id: 'run-manual',
        turn_id: 'turn',
        seq: 1,
        role: 'assistant',
        content: [
          {
            type: 'toolResult',
            toolCallId: 'call-run',
            toolName: 'runNodes',
            status: 'succeeded',
            title: '建议运行节点',
            canvasRun: { projectId: 'project', nodeIds: ['tub', 'scene'] },
          },
        ],
        created_at: NOW,
      },
      {
        conversation_id: 'busy',
        id: 'run-auto',
        turn_id: 'turn',
        seq: 2,
        role: 'assistant',
        content: [
          {
            type: 'toolResult',
            toolCallId: 'call-auto',
            toolName: 'runNodes',
            status: 'succeeded',
            title: '直接运行',
            canvasRun: { projectId: 'project', nodeIds: ['auto'], autoRun: true },
          },
        ],
        created_at: NOW,
      },
    ])

    const facts = await readConversationStateFacts('busy', NOW)
    expect(facts.pendingDrafts).toEqual([{ title: '把浴缸换成图2的款式' }])
    expect(facts.pendingNodeRuns).toEqual([{ title: '建议运行节点', nodeIds: ['tub', 'scene'] }])
    const done = facts.batches.find((one) => one.batchId === 'done')
    expect(done).toMatchObject({ status: 'closed', itemCount: 3, completed: 2, failed: 1 })
    expect(done?.artifactIds).toEqual(['agent_done-task-0_0', 'agent_done-task-1_0'])
    expect(facts.batches.find((one) => one.batchId === 'waiting')).toMatchObject({
      status: 'draft',
      itemCount: 4,
      completed: 0,
    })
  })

  it('ignores other conversations and batches outside the window', async () => {
    await conversation('quiet')
    await batch('quiet', 'old', 'closed', ['completed'], 1, NOW - CONVERSATION_STATE_WINDOW_MS - 1)
    const facts = await readConversationStateFacts('quiet', NOW)
    expect(facts).toEqual({ pendingDrafts: [], pendingNodeRuns: [], batches: [] })
    expect(renderConversationState(facts)).toBeUndefined()
  })
})

describe('renderConversationState', () => {
  it('tells the model a confirmation phrase must not resubmit finished work', () => {
    const text = renderConversationState({
      pendingDrafts: [{ title: '正面近景' }, { title: '俯视近景' }],
      pendingNodeRuns: [{ title: '建议运行节点', nodeIds: ['tub'] }],
      batches: [
        {
          batchId: 'b1',
          title: '六角度',
          status: 'closed',
          itemCount: 6,
          completed: 6,
          failed: 0,
          artifactIds: ['agent_t1_0'],
        },
        {
          batchId: 'b2',
          title: '修正',
          status: 'running',
          itemCount: 3,
          completed: 1,
          failed: 0,
          artifactIds: [],
        },
      ],
    })
    expect(text).toContain('待用户在卡片上确认的生成 2 张')
    expect(text).toContain('待用户在卡片上确认的节点运行 1 组')
    expect(text).toContain('节点 tub')
    expect(text).toContain('不要再催确认')
    expect(text).toContain('「正面近景」、「俯视近景」')
    expect(text).toContain('批次 b1「六角度」：已执行完毕，完成 6/6；产物：agent_t1_0')
    expect(text).toContain('批次 b2「修正」：执行中，已完成 1/3')
    expect(text).toContain('不要为这类话重新调用生成工具')
  })
})
