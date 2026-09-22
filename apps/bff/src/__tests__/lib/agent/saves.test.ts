import { afterAll, beforeEach, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { AgentAssetSaveCard, AgentToolResultBlock } from '@image-playground/shared'
import { and, eq } from 'drizzle-orm'

/**
 * 保存卡片落定的那一刻有两件事同时发生：卡片改写成已保存，收件箱里排上一条「用户已保存」。
 * 只写成一件，用户就会看见一张存过的卡而智能体毫不知情（或者反过来）。
 */

process.env.DATABASE_URL = await resetTestDatabase('bff_agent_saves')
process.env.PORT = '0'

// Dynamic imports keep environment setup ahead of modules that capture configuration.
const { markAgentSaveCardSaved } = await import('../../../lib/agent/saves')
const { queuedAgentMessages } = await import('../../../lib/agent/inbox')
const { close: closeDb, db, schema } = await import('../../../db/client')

const CONVERSATION = 'conversation-saves'
const DEVICE = 'device-abcdefgh'

const card: AgentAssetSaveCard = {
  kind: 'asset',
  status: 'pending',
  name: '浴缸',
  assetKind: 'product',
  background: 'transparent',
  views: [{ imageId: 'image-1', label: 'sheet', source: 'generated' }],
}

async function seed(block: AgentToolResultBlock): Promise<void> {
  const now = Date.now()
  await db.delete(schema.agent_conversations).where(eq(schema.agent_conversations.id, CONVERSATION))
  await db.insert(schema.agent_conversations).values({
    id: CONVERSATION,
    user_id: null,
    device_id: DEVICE,
    title: '做一套素材',
    created_at: now,
    updated_at: now,
  })
  await db.insert(schema.agent_messages).values({
    conversation_id: CONVERSATION,
    id: 'message-1',
    turn_id: 'turn-1',
    seq: 1,
    role: 'assistant',
    content: [block],
    created_at: now,
  })
}

function toolResult(saveCard: AgentToolResultBlock['saveCard']): AgentToolResultBlock {
  return {
    type: 'toolResult',
    toolCallId: 'call-1',
    toolName: 'saveAsset',
    status: 'succeeded',
    title: '存为素材：浴缸',
    ...(saveCard ? { saveCard } : {}),
  }
}

async function storedCard(): Promise<AgentToolResultBlock['saveCard']> {
  const [row] = await db
    .select()
    .from(schema.agent_messages)
    .where(
      and(
        eq(schema.agent_messages.conversation_id, CONVERSATION),
        eq(schema.agent_messages.id, 'message-1'),
      ),
    )
  const block = row?.content.find((one) => one.type === 'toolResult')
  return block?.type === 'toolResult' ? block.saveCard : undefined
}

function save(name = '浴缸', recordId = 'asset-1') {
  return markAgentSaveCardSaved({
    conversationId: CONVERSATION,
    toolCallId: 'call-1',
    kind: 'asset',
    recordId,
    name,
    deviceId: DEVICE,
  })
}

beforeEach(async () => {
  await seed(toolResult(card))
})

afterAll(async () => {
  await closeDb()
})

it('flips the stored card and tells the agent the user saved it', async () => {
  const outcome = await save('主图浴缸')

  expect(outcome.kind).toBe('saved')
  // 用户在卡上改过的名字才是记录的名字，模型拟的那个不算数。
  expect(await storedCard()).toMatchObject({
    status: 'saved',
    recordId: 'asset-1',
    name: '主图浴缸',
    views: card.views,
  })
  const queue = await queuedAgentMessages(CONVERSATION)
  expect(queue).toHaveLength(1)
  expect(queue[0]!.text).toBe('用户已保存素材「主图浴缸」（id: asset-1）')
})

/** 重发的请求、另一个标签页：同一张卡只存一次，智能体也只被告知一次。 */
it('is idempotent on a repeated save', async () => {
  await save('主图浴缸')
  const again = await save('别的名字', 'asset-2')

  expect(again.kind).toBe('replayed')
  expect(await storedCard()).toMatchObject({ recordId: 'asset-1', name: '主图浴缸' })
  expect(await queuedAgentMessages(CONVERSATION)).toHaveLength(1)
})

it('refuses a call that carries no save card', async () => {
  await seed(toolResult(undefined))

  expect(await save()).toEqual({ kind: 'not_savable' })
  expect(await queuedAgentMessages(CONVERSATION)).toHaveLength(0)
})

it('reports a card it cannot find', async () => {
  expect(
    await markAgentSaveCardSaved({
      conversationId: CONVERSATION,
      toolCallId: 'call-missing',
      kind: 'asset',
      recordId: 'asset-1',
      name: '浴缸',
      deviceId: DEVICE,
    }),
  ).toEqual({ kind: 'not_found' })
})
