import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'

process.env.DATABASE_URL = await resetTestDatabase('bff_agent_conversations')
process.env.PORT = '0'

// Dynamic imports keep environment setup ahead of modules that capture configuration.
const { close: closeDb, db, schema } = await import('../../db/client')
const {
  appendAgentMessage,
  createAgentConversation,
  findAgentConversation,
  listAgentMessages,
  softDeleteAgentConversation,
} = await import('../../lib/agent/conversations')

const USER = { kind: 'user', userId: 'owner-user' } as const
const DEVICE = { kind: 'device', deviceId: 'device-abcdefgh' } as const

beforeEach(async () => {
  await db.delete(schema.agent_conversations)
  await db.delete(schema.users)
  const now = Date.now()
  await db.insert(schema.users).values({
    id: USER.userId,
    username: USER.userId,
    password_hash: 'fixture-hash',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
})

afterAll(async () => {
  await closeDb()
})

describe('agent conversations', () => {
  it('reads back a conversation owned by a user', async () => {
    const created = await createAgentConversation(USER, '把背景换成浅木色')

    expect(created.title).toBe('把背景换成浅木色')
    expect(await findAgentConversation(created.id, USER)).toEqual(created)
  })

  it('reads back a conversation owned by an anonymous device', async () => {
    const created = await createAgentConversation(DEVICE, '先试试')

    expect(await findAgentConversation(created.id, DEVICE)).toEqual(created)
  })

  it('hides a conversation from another owner', async () => {
    const created = await createAgentConversation(DEVICE, '先试试')

    expect(await findAgentConversation(created.id, USER)).toBeNull()
    expect(
      await findAgentConversation(created.id, { kind: 'device', deviceId: 'device-zzzzzzzz' }),
    ).toBeNull()
  })

  it('keeps appended messages in order and carries their turn', async () => {
    const conversation = await createAgentConversation(USER, '第一句')

    const question = await appendAgentMessage(db, {
      conversationId: conversation.id,
      turnId: 'turn-1',
      role: 'user',
      content: [{ type: 'text', text: '第一句' }],
    })
    const answer = await appendAgentMessage(db, {
      conversationId: conversation.id,
      turnId: 'turn-1',
      role: 'assistant',
      content: [{ type: 'text', text: '好的' }],
    })

    expect(await listAgentMessages(conversation.id)).toEqual([question, answer])
    expect(answer.turnId).toBe('turn-1')
  })

  it('drops a soft deleted conversation from reads', async () => {
    const conversation = await createAgentConversation(USER, '第一句')
    await appendAgentMessage(db, {
      conversationId: conversation.id,
      turnId: 'turn-1',
      role: 'user',
      content: [{ type: 'text', text: '第一句' }],
    })

    await softDeleteAgentConversation(conversation.id, USER)

    expect(await findAgentConversation(conversation.id, USER)).toBeNull()
    expect(await listAgentMessages(conversation.id)).toEqual([])
  })

  it('removes the conversations of a deleted user', async () => {
    const conversation = await createAgentConversation(USER, '第一句')

    await db.delete(schema.users)

    expect(await findAgentConversation(conversation.id, USER)).toBeNull()
  })

  it('refuses a row that claims both a user and a device', async () => {
    const now = Date.now()
    const insert = async () => {
      await db.insert(schema.agent_conversations).values({
        id: 'both-owners',
        user_id: USER.userId,
        device_id: DEVICE.deviceId,
        title: '两个归属',
        created_at: now,
        updated_at: now,
      })
    }

    expect(insert()).rejects.toThrow()
  })
})
