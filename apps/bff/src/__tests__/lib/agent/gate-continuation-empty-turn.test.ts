import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { AgentMessageView, AgentTurnEvent } from '@image-playground/shared'
import { completionStream, recordingAgentFetch } from '../../helpers/agentStubs'

process.env.DATABASE_URL = await resetTestDatabase('agent_gate_continuation_empty')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.AGENT_SUMMARY_MODEL = 'fixture-summary-model'
process.env.AGENT_CHAT_CONTEXT_WINDOW = '128000'
process.env.AGENT_CHAT_MAX_TOKENS = '500'
process.env.OPERATOR_CONFIG_FILE = resolve(
  import.meta.dir,
  '../../agent-compaction-operator-config.json',
)

const { setAgentFetchForTesting, setAgentRetryBackoffForTesting } = await import(
  '../../../lib/agent/model'
)
setAgentRetryBackoffForTesting(0)
const { startAgentTurn } = await import('../../../lib/agent/turn')
const { ANONYMOUS_AUDIENCE } = await import('../../../lib/agent/skills')
const { createAgentConversation } = await import('../../../lib/agent/conversations')
const { close: closeDb, db, schema } = await import('../../../db/client')
const { GATE_CONTINUATION_EMPTY_REPLY } = await import('../../../lib/agent/gate-continuation-empty')

type PreparedAgentTurn = import('../../../lib/agent/turn').PreparedAgentTurn

const CONTINUATION = {
  turnId: 'gated-turn',
  calls: [
    {
      toolCallId: 'call-generate-1',
      toolName: 'generateImage',
      args: { prompt: '一只猫' },
      result: '已按用户要求提交生成任务，结果会显示在对话的产物卡片中。',
    },
  ],
} as const

function prepared(
  conversationId: string,
  turnId: string,
  options: { continuation?: typeof CONTINUATION; text: string },
): PreparedAgentTurn {
  const history: AgentMessageView[] = [
    {
      id: 'user-1',
      turnId: 'gated-turn',
      role: 'user',
      content: [{ type: 'text', text: '画一只猫' }],
      createdAt: 1,
    },
  ]
  return {
    execution: { assert: async () => {}, write: (callback) => db.transaction(callback) },
    conversationId,
    owner: { kind: 'device', deviceId: 'device-abcdefgh' },
    turnId,
    userMessageId: options.continuation ? `${turnId}:resume` : 'next',
    input: {
      currentTime: '2026-11-10T00:00:00.000Z',
      history: {
        messages: history,
        coveredCount: 0,
        compaction: {
          summary: null,
          anchor: null,
          verbatim: null,
          failureCount: 0,
          openedAt: null,
        },
      },
      text: options.text,
      references: [],
      mode: 'image',
      reviewImageIds: [],
      autoSubmit: false,
      selectionHistoryStart: history.length,
      audience: ANONYMOUS_AUDIENCE,
      ...(options.continuation ? { continuation: options.continuation } : {}),
    },
    userId: null,
    deviceId: 'device-abcdefgh',
  }
}

async function runTurn(options: {
  continuation?: typeof CONTINUATION
  text: string
  reply: () => Response
}): Promise<AgentTurnEvent[]> {
  setAgentFetchForTesting(recordingAgentFetch([], options.reply))
  const conversation = await createAgentConversation(
    { kind: 'device', deviceId: 'device-abcdefgh' },
    '画一只猫',
  )
  const turn = await startAgentTurn(
    prepared(conversation.id, `turn-${crypto.randomUUID()}`, {
      continuation: options.continuation,
      text: options.text,
    }),
  )
  const events: AgentTurnEvent[] = []
  for await (const stored of turn.read(0)) events.push(stored.event)
  return events
}

function textOf(events: readonly AgentTurnEvent[]): string {
  return events
    .filter(
      (event): event is Extract<AgentTurnEvent, { type: 'textDelta' }> =>
        event.type === 'textDelta',
    )
    .map((event) => event.delta)
    .join('')
}

function turnEndOf(events: readonly AgentTurnEvent[]) {
  const end = events.find((event) => event.type === 'turnEnd')
  if (!end || end.type !== 'turnEnd') throw new Error('missing turnEnd')
  return end
}

beforeEach(async () => {
  await db.delete(schema.agent_conversations)
})

afterEach(() => {
  setAgentFetchForTesting()
})

afterAll(async () => {
  await closeDb()
})

describe('gate continuation empty fallback', () => {
  it('stores a fixed reply and completes when a continuation writes nothing visible', async () => {
    const events = await runTurn({
      continuation: CONTINUATION,
      text: '',
      reply: () => completionStream(),
    })
    const end = turnEndOf(events)
    expect(end.stopReason).toBe('completed')
    expect(end.error).toBeUndefined()
    expect(textOf(events)).toBe(GATE_CONTINUATION_EMPTY_REPLY)
  })

  it('keeps the model reply when a continuation already wrote visible text', async () => {
    const events = await runTurn({
      continuation: CONTINUATION,
      text: '',
      reply: () => completionStream('图已经在排队生成了。'),
    })
    const end = turnEndOf(events)
    expect(end.stopReason).toBe('completed')
    expect(end.error).toBeUndefined()
    expect(textOf(events)).toBe('图已经在排队生成了。')
    expect(textOf(events)).not.toContain(GATE_CONTINUATION_EMPTY_REPLY)
  })

  it('still fails an empty ordinary user turn as agent_run_failed', async () => {
    const events = await runTurn({
      text: '再来一张',
      reply: () => completionStream(),
    })
    const end = turnEndOf(events)
    expect(end.stopReason).toBe('failed')
    expect(end.error).toBe('agent_run_failed')
    expect(textOf(events)).not.toContain(GATE_CONTINUATION_EMPTY_REPLY)
  })
})
