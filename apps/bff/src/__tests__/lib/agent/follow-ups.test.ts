import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { AgentMessageView } from '@image-playground/shared'

process.env.DATABASE_URL = await resetTestDatabase('bff_agent_follow_ups')
process.env.PORT = '0'

const {
  followUpLimitsForTesting,
  followUpSource,
  normalizeFollowUpLines,
  readAgentFollowUps,
  recordAgentFollowUps,
  scheduleAgentFollowUps,
  setFollowUpRetryDelayForTesting,
  suggestFollowUps,
} = await import('../../../lib/agent/follow-ups')
const { ChatTimeoutError, ChatUpstreamError } = await import('../../../lib/chatCompletion')
const { listAgentTurnSummaries, recordAgentTurnSummary } = await import(
  '../../../lib/agent/turn-summary'
)
const { appendAgentMessage, createAgentConversation } = await import(
  '../../../lib/agent/conversations'
)
const { close: closeDb, db, schema } = await import('../../../db/client')

function message(role: 'user' | 'assistant', text: string, createdAt: number): AgentMessageView {
  return {
    id: `${role}-${createdAt}`,
    turnId: 'turn-1',
    role,
    content: text ? [{ type: 'text', text }] : [],
    createdAt,
  }
}

async function conversation(): Promise<string> {
  const view = await createAgentConversation({ kind: 'device', deviceId: 'device-abcdefgh' }, '')
  return view.id
}

beforeEach(async () => {
  setFollowUpRetryDelayForTesting(0)
  await db.delete(schema.agent_conversations)
})

afterAll(async () => {
  await closeDb()
})

describe('下一句的句子', () => {
  it('丢掉空句、重复、超长和用户刚说的那句，只留第一句预测', () => {
    const user = '画一张秋日海报'
    expect(
      normalizeFollowUpLines({ lines: ['  再出一版夜景。  ', user, '', '再出一版夜景。'] }, user),
    ).toEqual(['再出一版夜景。'])
    const long = '字'.repeat(81)
    expect(
      normalizeFollowUpLines(
        { lines: ['换成暖光。', long, '标题改成英文 Autumn Blend。', '再出一张方形。'] },
        user,
      ),
    ).toEqual(['换成暖光。'])
    expect(normalizeFollowUpLines({ lines: [user, '', long] }, user)).toEqual([])
    expect(normalizeFollowUpLines({ lines: ['刚好八十个字。'] }, '')).toEqual(['刚好八十个字。'])
    expect(normalizeFollowUpLines('不是对象')).toEqual([])
  })

  it('取这一轮最后一句用户的话和最后一段助手文字', () => {
    expect(
      followUpSource([
        message('assistant', '先看见的回复', 2),
        message('user', '后发的那句', 3),
        message('user', '先发的那句', 1),
        message('assistant', '', 4),
      ]),
    ).toEqual({
      userText: '后发的那句',
      assistantText: '先看见的回复',
      recentContext: '用户：先发的那句\n用户：后发的那句',
    })
    expect(followUpSource([message('assistant', '只有回复', 1)])).toBeNull()
  })

  it('按用户口吻预测一句，失败或答不出就当没有', async () => {
    const seen: string[] = []
    const lines = await suggestFollowUps(
      {
        userText: 'Make an autumn poster',
        assistantText: 'What title and ratio should I use?',
        recentContext: '用户：Make an autumn poster',
      },
      async (prompt) => {
        seen.push(prompt)
        return { lines: ['Use the title Autumn Blend at 3:4.', 'Set the title to Autumn Blend.'] }
      },
    )
    expect(lines).toEqual(['Use the title Autumn Blend at 3:4.'])
    expect(seen[0]).toContain('Make an autumn poster')
    expect(seen[0]).toContain('What title and ratio should I use?')
    expect(seen[0]).toContain('用用户的口吻、第一人称')
    expect(seen[0]).toContain('只写一句')
    expect(seen[0]).toContain('用合理的具体取值直接回答，不要反问')
    expect(seen[0]).toContain('用用户上一条消息的语言写')
    expect(seen[0]).not.toContain('分别碰画面')

    const asked = viAsk()
    expect(await suggestFollowUps({ userText: '   ', assistantText: '有回复' }, asked.ask)).toEqual(
      [],
    )
    expect(asked.calls).toBe(0)
    const down = countedAsk(() => {
      throw new Error('upstream down')
    })
    expect(await suggestFollowUps({ userText: '画一张', assistantText: '好' }, down.ask)).toEqual(
      [],
    )
    expect(down.calls).toBe(1)
  })

  it('单次 30 秒，超时或瞬时故障只再试一次', async () => {
    expect(followUpLimitsForTesting()).toEqual({ timeoutMs: 30_000, attempts: 2 })

    const timeout = countedAsk((call) => {
      if (call === 1) throw new ChatTimeoutError(30_000)
      return { lines: ['换成夜景。', '出一张方形。'] }
    })
    expect(
      await suggestFollowUps({ userText: '画一张', assistantText: '好' }, timeout.ask),
    ).toEqual(['换成夜景。'])
    expect(timeout.calls).toBe(2)

    const hung = countedAsk(() => {
      throw new ChatTimeoutError(30_000)
    })
    expect(await suggestFollowUps({ userText: '画一张', assistantText: '好' }, hung.ask)).toEqual(
      [],
    )
    expect(hung.calls).toBe(2)

    const gateway = countedAsk((call) => {
      if (call === 1) throw new ChatUpstreamError(502, 'bad gateway')
      return { lines: ['灯光暖一点。', '再出一张方形。'] }
    })
    expect(
      await suggestFollowUps({ userText: '画一张', assistantText: '好' }, gateway.ask),
    ).toEqual(['灯光暖一点。'])
    expect(gateway.calls).toBe(2)

    const quota = countedAsk(() => {
      throw new ChatUpstreamError(429, 'insufficient_quota')
    })
    expect(await suggestFollowUps({ userText: '画一张', assistantText: '好' }, quota.ask)).toEqual(
      [],
    )
    expect(quota.calls).toBe(1)
  })
})

describe('下一句落库', () => {
  it('页脚重写不会清掉已经写上的句子，空数组表示问过', async () => {
    const conversationId = await conversation()
    await recordAgentTurnSummary({
      conversationId,
      turnId: 'turn-1',
      durationMs: 20,
      stopReason: 'completed',
    })
    expect(await readAgentFollowUps(conversationId, 'turn-1')).toBeNull()
    expect(await readAgentFollowUps(conversationId, 'missing')).toEqual([])

    await recordAgentFollowUps(conversationId, 'turn-1', ['换成夜景。', '出一张方形。'])
    await recordAgentTurnSummary({
      conversationId,
      turnId: 'turn-1',
      durationMs: 40,
      stopReason: 'completed',
      cost: { chat: 1, image: 0, video: 0 },
    })
    expect(await readAgentFollowUps(conversationId, 'turn-1')).toEqual([
      '换成夜景。',
      '出一张方形。',
    ])
    expect(await listAgentTurnSummaries(conversationId)).toEqual([
      {
        turnId: 'turn-1',
        durationMs: 40,
        stopReason: 'completed',
        cost: { chat: 1, image: 0, video: 0 },
        followUps: ['换成夜景。', '出一张方形。'],
      },
    ])

    await recordAgentFollowUps(conversationId, 'turn-1', [])
    expect(await readAgentFollowUps(conversationId, 'turn-1')).toEqual([])
    expect(await listAgentTurnSummaries(conversationId)).toEqual([
      {
        turnId: 'turn-1',
        durationMs: 40,
        stopReason: 'completed',
        cost: { chat: 1, image: 0, video: 0 },
      },
    ])
  })

  it('没有用户原话就记空数组，有原话就把模型的句子写上', async () => {
    const conversationId = await conversation()
    await recordAgentTurnSummary({
      conversationId,
      turnId: 'turn-1',
      durationMs: 10,
      stopReason: 'completed',
    })
    scheduleAgentFollowUps({
      conversationId,
      turnId: 'turn-1',
      messages: [message('assistant', '只有回复', 1)],
    })
    await settled(conversationId, 'turn-1')
    expect(await readAgentFollowUps(conversationId, 'turn-1')).toEqual([])

    await recordAgentTurnSummary({
      conversationId,
      turnId: 'turn-2',
      durationMs: 10,
      stopReason: 'completed',
    })
    scheduleAgentFollowUps(
      {
        conversationId,
        turnId: 'turn-2',
        messages: [message('user', '画一张海报', 1), message('assistant', '画好了', 2)],
      },
      async () => ({ lines: ['背景改成夜晚。', '再出一张方形。'] }),
    )
    await settled(conversationId, 'turn-2')
    expect(await readAgentFollowUps(conversationId, 'turn-2')).toEqual(['背景改成夜晚。'])
  })

  it('超时重试还没结束时仍是 pending，两次都失败才写成空数组', async () => {
    const conversationId = await conversation()
    await recordAgentTurnSummary({
      conversationId,
      turnId: 'turn-1',
      durationMs: 10,
      stopReason: 'completed',
    })
    let calls = 0
    let release = () => {}
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const { promise: secondStarted, resolve: markSecond } = Promise.withResolvers<void>()
    scheduleAgentFollowUps(
      {
        conversationId,
        turnId: 'turn-1',
        messages: [message('user', '画一张海报', 1), message('assistant', '画好了', 2)],
      },
      async () => {
        calls += 1
        if (calls === 1) throw new ChatTimeoutError(30_000)
        markSecond()
        await hold
        throw new ChatTimeoutError(30_000)
      },
    )
    await secondStarted
    expect(calls).toBe(2)
    expect(await readAgentFollowUps(conversationId, 'turn-1')).toBeNull()
    release()
    await settled(conversationId, 'turn-1')
    expect(await readAgentFollowUps(conversationId, 'turn-1')).toEqual([])
    expect(calls).toBe(2)
  })

  it('出图后的复查没有新的用户原话时，沿用会话里上一句', async () => {
    const conversationId = await conversation()
    await appendAgentMessage(db, {
      conversationId,
      turnId: 'turn-prev',
      role: 'user',
      content: [{ type: 'text', text: '先出男主设定图' }],
    })
    await recordAgentTurnSummary({
      conversationId,
      turnId: 'turn-review',
      durationMs: 10,
      stopReason: 'completed',
    })
    const seen: string[] = []
    scheduleAgentFollowUps(
      {
        conversationId,
        turnId: 'turn-review',
        messages: [message('assistant', '设定图出好了，可以作为基准。', 2)],
      },
      async (prompt) => {
        seen.push(prompt)
        return { lines: ['把这张存成素材。', '出第一场分镜。'] }
      },
    )
    await settled(conversationId, 'turn-review')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain('先出男主设定图')
    expect(seen[0]).toContain('设定图出好了，可以作为基准。')
    expect(seen[0]).toContain('用户：先出男主设定图')
    expect(await readAgentFollowUps(conversationId, 'turn-review')).toEqual(['把这张存成素材。'])
  })
})

function viAsk(): { ask: () => Promise<unknown>; calls: number } {
  const state = { calls: 0, ask: async () => ((state.calls += 1), null) }
  return state
}

function countedAsk(run: (call: number) => unknown): {
  ask: () => Promise<unknown>
  calls: number
} {
  const state = {
    calls: 0,
    ask: async () => {
      state.calls += 1
      return run(state.calls)
    },
  }
  return state
}

async function settled(conversationId: string, turnId: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await readAgentFollowUps(conversationId, turnId)) !== null) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`${turnId} follow-ups stayed pending`)
}
