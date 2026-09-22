import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { AgentCompactionRecord } from '@image-playground/shared'
import { and, eq } from 'drizzle-orm'

process.env.DATABASE_URL = await resetTestDatabase('bff_agent_conversations')
process.env.PORT = '0'

// Dynamic imports keep environment setup ahead of modules that capture configuration.
const { close: closeDb, db, schema } = await import('../../db/client')
const {
  appendAgentMessage,
  createAgentConversation,
  findAgentConversation,
  listAgentHistoryWindow,
  listAgentMessages,
  listAgentTurnMessages,
  loadAgentCompaction,
  setAgentConversationTitle,
  saveAgentCompaction,
  softDeleteAgentConversation,
} = await import('../../lib/agent/conversations')

const USER = { kind: 'user', userId: 'owner-user' } as const
const DEVICE = { kind: 'device', deviceId: 'device-abcdefgh' } as const

const NARRATIVE = {
  completed: '出了三张图',
  inProgress: '在调背景',
  decisions: '主体不换',
  artifacts: 'img-1',
}
const VERBATIM = { omittedCount: 1, omittedChars: 12, kept: ['把背景换成浅木色'] }

async function say(conversationId: string, turnId: string, text: string) {
  return appendAgentMessage(db, {
    conversationId,
    turnId,
    role: 'user',
    content: [{ type: 'text', text }],
  })
}

async function fold(
  conversationId: string,
  anchor: NonNullable<AgentCompactionRecord['anchor']>,
  rest: Partial<AgentCompactionRecord> = {},
) {
  await saveAgentCompaction(conversationId, {
    summary: NARRATIVE,
    anchor,
    verbatim: VERBATIM,
    failureCount: 0,
    openedAt: null,
    ...rest,
  })
}

beforeEach(async () => {
  await db.delete(schema.tasks)
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
  it('recovers legacy full prompts only from tasks in the authorized conversation', async () => {
    const conversation = await createAgentConversation(USER, '生成设计')
    const foreign = await createAgentConversation(DEVICE, '别人的设计')
    for (const [id, conversationId, prompt] of [
      ['own', conversation.id, '完整提示词\n保留所有细节'],
      ['foreign', foreign.id, '不可泄露'],
    ] as const) {
      await db.insert(schema.tasks).values({
        id,
        provider: 'openai-compat',
        model: 'gpt-image-1',
        status: 'completed',
        submitted_at: Date.now(),
        agent_conversation_id: conversationId,
        request_payload: { device_id: DEVICE.deviceId, prompt },
      })
      await appendAgentMessage(db, {
        conversationId: conversation.id,
        turnId: 'turn-1',
        role: 'assistant',
        content: [
          {
            type: 'toolResult',
            toolCallId: id,
            toolName: 'generateImage',
            status: 'succeeded',
            title: '摘要…',
            artifacts: [
              { artifactId: id, taskId: id, media: 'image', outputIndex: 0, mime: 'image/png' },
            ],
          },
        ],
      })
    }
    const messages = await listAgentMessages(conversation.id, USER)
    expect(messages[0]?.content[0]).toMatchObject({ prompt: '完整提示词\n保留所有细节' })
    expect(messages[1]?.content[0]).not.toHaveProperty('prompt')
    expect(await listAgentMessages(conversation.id, DEVICE)).toEqual([])
  })

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

    expect(await listAgentMessages(conversation.id, USER)).toEqual([question, answer])
    expect(answer.turnId).toBe('turn-1')
  })

  it('answers nothing to an owner the conversation does not belong to', async () => {
    const conversation = await createAgentConversation(USER, '第一句')
    await appendAgentMessage(db, {
      conversationId: conversation.id,
      turnId: 'turn-1',
      role: 'user',
      content: [{ type: 'text', text: '第一句' }],
    })

    expect(await listAgentMessages(conversation.id, DEVICE)).toEqual([])

    await setAgentConversationTitle(db, conversation.id, DEVICE, '改成别的')
    expect((await findAgentConversation(conversation.id, USER))!.title).toBe('第一句')
  })

  it('only renames while the title is still the one the caller saw', async () => {
    const conversation = await createAgentConversation(USER, '第一句')

    await setAgentConversationTitle(db, conversation.id, USER, '小模型起的名字', '第一句')
    expect((await findAgentConversation(conversation.id, USER))!.title).toBe('小模型起的名字')

    // 迟到的那一次：标题已经不是它出发时那句，不覆盖。
    await setAgentConversationTitle(db, conversation.id, USER, '更迟的名字', '第一句')
    expect((await findAgentConversation(conversation.id, USER))!.title).toBe('小模型起的名字')
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
    expect(await listAgentMessages(conversation.id, USER)).toEqual([])
  })

  it('removes the conversations of a deleted user', async () => {
    const conversation = await createAgentConversation(USER, '第一句')

    await db.delete(schema.users)

    expect(await findAgentConversation(conversation.id, USER)).toBeNull()
  })

  it('round-trips the compaction state of a conversation', async () => {
    const conversation = await createAgentConversation(USER, '第一句')
    expect(await loadAgentCompaction(conversation.id)).toBeNull()

    const record = {
      summary: NARRATIVE,
      anchor: { lastMessageId: 'msg-9', coveredCount: 9 },
      verbatim: VERBATIM,
      failureCount: 0,
      openedAt: null,
    }
    await saveAgentCompaction(conversation.id, record)

    expect(await loadAgentCompaction(conversation.id)).toEqual(record)
  })

  it('leaves the stored messages untouched when compaction state is written', async () => {
    const conversation = await createAgentConversation(USER, '第一句')
    await appendAgentMessage(db, {
      conversationId: conversation.id,
      turnId: 'turn-1',
      role: 'user',
      content: [{ type: 'text', text: '把背景换成浅木色' }],
    })
    const before = await listAgentMessages(conversation.id, USER)

    await saveAgentCompaction(conversation.id, {
      summary: NARRATIVE,
      anchor: { lastMessageId: before[0]!.id, coveredCount: 1 },
      verbatim: VERBATIM,
      failureCount: 0,
      openedAt: null,
    })

    expect(await listAgentMessages(conversation.id, USER)).toEqual(before)
  })

  it('reads the whole history back when nothing has been folded into a summary', async () => {
    const conversation = await createAgentConversation(USER, '第一句')
    const first = await say(conversation.id, 'turn-1', '把背景换成浅木色')
    const second = await say(conversation.id, 'turn-2', '再亮一点')

    const window = await listAgentHistoryWindow(conversation.id, USER)

    expect(window.messages).toEqual([first, second])
    expect(window.coveredCount).toBe(0)
    expect(window.compaction.summary).toBeNull()
  })

  it('hands back only the messages the summary does not already cover', async () => {
    const conversation = await createAgentConversation(USER, '第一句')
    await say(conversation.id, 'turn-1', '把背景换成浅木色')
    const anchor = await say(conversation.id, 'turn-2', '再亮一点')
    const fresh = await say(conversation.id, 'turn-3', '导出大图')
    await fold(conversation.id, { lastMessageId: anchor.id, coveredCount: 2 })

    const window = await listAgentHistoryWindow(conversation.id, USER)

    expect(window.messages).toEqual([fresh])
    expect(window.coveredCount).toBe(2)
    expect(window.compaction.summary).toEqual(NARRATIVE)
  })

  it('drops a summary whose covered stretch lost a message but keeps the breaker counters', async () => {
    const conversation = await createAgentConversation(USER, '第一句')
    const retracted = await say(conversation.id, 'turn-1', '把背景换成浅木色')
    const anchor = await say(conversation.id, 'turn-2', '再亮一点')
    const fresh = await say(conversation.id, 'turn-3', '导出大图')
    await fold(
      conversation.id,
      { lastMessageId: anchor.id, coveredCount: 2 },
      { failureCount: 2, openedAt: 1_700_000_000_000 },
    )

    // 折进摘要之后才删的那一条：锚点还在，只比 id 认不出它没了，那段内容就被永久冻在摘要里。
    await db
      .update(schema.agent_messages)
      .set({ deleted_at: Date.now() })
      .where(
        and(
          eq(schema.agent_messages.conversation_id, conversation.id),
          eq(schema.agent_messages.id, retracted.id),
        ),
      )

    const window = await listAgentHistoryWindow(conversation.id, USER)

    expect(window.messages).toEqual([anchor, fresh])
    expect(window.coveredCount).toBe(0)
    expect(window.compaction).toEqual({
      summary: null,
      anchor: null,
      verbatim: null,
      failureCount: 2,
      openedAt: 1_700_000_000_000,
    })
  })

  it('refolds a record left by the version that stored no verbatim archive', async () => {
    const conversation = await createAgentConversation(USER, '第一句')
    const folded = await say(conversation.id, 'turn-1', '把背景换成浅木色')
    const fresh = await say(conversation.id, 'turn-2', '再亮一点')
    // 上一版落下的行：那时还没有 verbatim 这一节，用户原话补不出来，只能重折。
    const legacy: Omit<AgentCompactionRecord, 'verbatim'> = {
      summary: NARRATIVE,
      anchor: { lastMessageId: folded.id, coveredCount: 1 },
      failureCount: 0,
      openedAt: null,
    }
    await db
      .update(schema.agent_conversations)
      .set({ compaction: legacy as AgentCompactionRecord })
      .where(eq(schema.agent_conversations.id, conversation.id))

    const window = await listAgentHistoryWindow(conversation.id, USER)

    expect(window.messages).toEqual([folded, fresh])
    expect(window.coveredCount).toBe(0)
    expect(window.compaction.summary).toBeNull()
  })

  it('answers an empty window to an owner the conversation does not belong to', async () => {
    const conversation = await createAgentConversation(USER, '第一句')
    const folded = await say(conversation.id, 'turn-1', '把背景换成浅木色')
    await fold(
      conversation.id,
      { lastMessageId: folded.id, coveredCount: 1 },
      { failureCount: 3, openedAt: 1_700_000_000_000 },
    )

    const window = await listAgentHistoryWindow(conversation.id, DEVICE)

    expect(window.messages).toEqual([])
    expect(window.coveredCount).toBe(0)
    expect(window.compaction).toEqual({
      summary: null,
      anchor: null,
      verbatim: null,
      failureCount: 0,
      openedAt: null,
    })
  })

  it('fetches every message of the named turns, including turns older than the window', async () => {
    const conversation = await createAgentConversation(USER, '第一句')
    const asked = await say(conversation.id, 'turn-1', '把背景换成浅木色')
    const again = await say(conversation.id, 'turn-2', '再亮一点')
    const anchor = await say(conversation.id, 'turn-2', '就这个方向')
    const latest = await say(conversation.id, 'turn-3', '导出大图')
    await fold(conversation.id, { lastMessageId: anchor.id, coveredCount: 3 })

    expect((await listAgentHistoryWindow(conversation.id, USER)).messages).toEqual([latest])
    expect(await listAgentTurnMessages(conversation.id, USER, ['turn-2', 'turn-1'])).toEqual([
      asked,
      again,
      anchor,
    ])
  })

  it('hands no turn messages to an owner the conversation does not belong to', async () => {
    const conversation = await createAgentConversation(USER, '第一句')
    await say(conversation.id, 'turn-1', '把背景换成浅木色')

    expect(await listAgentTurnMessages(conversation.id, DEVICE, ['turn-1'])).toEqual([])
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
