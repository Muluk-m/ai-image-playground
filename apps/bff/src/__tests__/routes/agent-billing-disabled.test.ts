import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import type {
  AgentTurnEndEvent,
  AgentTurnStartEvent,
  AgentTurnSummaryView,
} from '@image-playground/shared'
import { DEVICE_ID_HEADER } from '@image-playground/shared'
import { Elysia } from 'elysia'
import { _setPrivateBffOverlayForTesting } from '../../lib/private-overlay'
import { completionStream, parseFrames, recordingAgentFetch } from '../helpers/agentStubs'
import { silenceChatUpstream } from '../helpers/chatStubs'
import { installRecordingTaskHooks } from '../helpers/privateOverlayStub'

process.env.DATABASE_URL = await resetTestDatabase('agent_billing_a288_off')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.UPSTREAM_OPENAI_API_KEY = ''
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../agent-operator-config.json')

// overlay 在场但 billing:credits 关着：这一组钉的是能力开关，不是 overlay 缺席。
const billing = installRecordingTaskHooks()

const { agentRoutes } = await import('../../routes/agent')
const { setAgentFetchForTesting } = await import('../../lib/agent/model')
const { close: closeDb, db, schema } = await import('../../db/client')
const { purgeOldAgentTurnEvents } = await import('../../lib/agent/events')

await silenceChatUpstream()

const app = new Elysia().use(agentRoutes)
const DEVICE = 'device-abcdefgh'

async function post(path: string, body: unknown): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

async function readTurnSummaries(conversationId: string): Promise<AgentTurnSummaryView[]> {
  const response = await app.handle(
    new Request(`http://localhost/api/agent/conversations/${conversationId}/messages`, {
      headers: { [DEVICE_ID_HEADER]: DEVICE },
    }),
  )
  return ((await response.json()) as { turns: AgentTurnSummaryView[] }).turns
}

beforeEach(async () => {
  billing.reset()
  await db.delete(schema.tasks)
  await db.delete(schema.agent_conversations)
})

afterEach(() => {
  setAgentFetchForTesting()
})

afterAll(async () => {
  _setPrivateBffOverlayForTesting()
  await closeDb()
})

describe('billing:credits 关着的部署', () => {
  it('匿名设备照常跑完一轮，一笔占用也不写', async () => {
    setAgentFetchForTesting(recordingAgentFetch([], () => completionStream('好的，', '这就改')))
    const created = await post('/api/agent/conversations', { deviceId: DEVICE })
    const { conversation } = (await created.json()) as { conversation: { id: string } }

    const response = await post(`/api/agent/conversations/${conversation.id}/turns`, {
      deviceId: DEVICE,
      text: '把背景换成浅木色',
    })
    const frames = parseFrames(await response.text())

    expect(response.status).toBe(200)
    expect(frames.at(-1)!.event).toMatchObject({ type: 'turnEnd', stopReason: 'completed' })
    expect(billing.reservations).toEqual([])
    expect(billing.settlements).toEqual([])
  })

  it('不同设备与会话的独立用量不会混进下一轮', async () => {
    setAgentFetchForTesting(recordingAgentFetch([], () => completionStream('好')))
    const spaces: { id: string; device: string }[] = []
    for (const device of [DEVICE, 'device-other-abcdefgh']) {
      const created = await post('/api/agent/conversations', { deviceId: device })
      const { conversation } = (await created.json()) as { conversation: { id: string } }
      spaces.push({ id: conversation.id, device })
      for (let turn = 0; turn < 2; turn += 1) {
        const response = await post(`/api/agent/conversations/${conversation.id}/turns`, {
          deviceId: device,
          text: '继续',
        })
        expect(parseFrames(await response.text()).at(-1)?.event).toMatchObject({
          type: 'turnEnd',
          usage: { inputTokens: 12, outputTokens: 4 },
        })
      }
    }
    const rows = await db.select().from(schema.agent_model_calls)
    expect(rows).toHaveLength(4)
    for (const space of spaces) {
      const own = rows.filter((row) => row.conversation_id === space.id)
      expect(own).toHaveLength(2)
      expect(new Set(own.map((row) => row.turn_id)).size).toBe(2)
      for (const row of own) expect(row).toMatchObject({ user_id: null, device_id: space.device })
    }
    const forbidden = await post(`/api/agent/conversations/${spaces[0]!.id}/turns`, {
      deviceId: spaces[1]!.device,
      text: '跨设备读取',
    })
    expect(forbidden.status).toBe(404)
    expect(await db.select().from(schema.agent_model_calls)).toHaveLength(4)
    expect(billing.reservations).toEqual([])
  })

  it('轮的两头都不带积分，界面上因此没有消耗可显示', async () => {
    setAgentFetchForTesting(recordingAgentFetch([], () => completionStream('好')))
    const created = await post('/api/agent/conversations', { deviceId: DEVICE })
    const { conversation } = (await created.json()) as { conversation: { id: string } }

    const response = await post(`/api/agent/conversations/${conversation.id}/turns`, {
      deviceId: DEVICE,
      text: '把背景换成浅木色',
    })
    const frames = parseFrames(await response.text())

    const start = frames[0]!.event as AgentTurnStartEvent
    const end = frames.at(-1)!.event as AgentTurnEndEvent
    expect(start.reservedCredits).toBeUndefined()
    expect(end.cost).toBeUndefined()
  })

  it('事件过期后翻回去只剩耗时，没有消耗可显示', async () => {
    setAgentFetchForTesting(recordingAgentFetch([], () => completionStream('好')))
    const created = await post('/api/agent/conversations', { deviceId: DEVICE })
    const { conversation } = (await created.json()) as { conversation: { id: string } }

    const response = await post(`/api/agent/conversations/${conversation.id}/turns`, {
      deviceId: DEVICE,
      text: '把背景换成浅木色',
    })
    const frames = parseFrames(await response.text())
    const turnId = (frames[0]!.event as AgentTurnStartEvent).turnId
    await purgeOldAgentTurnEvents(0, Date.now() + 1_000)

    const turns = await readTurnSummaries(conversation.id)
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ turnId, stopReason: 'completed' })
    expect(turns[0]!.cost).toBeUndefined()
    expect(turns[0]!.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('不计费的轮不写任何任务行，worker 与恢复扫描照旧看不到对话轮', async () => {
    setAgentFetchForTesting(recordingAgentFetch([], () => completionStream('好')))
    const created = await post('/api/agent/conversations', { deviceId: DEVICE })
    const { conversation } = (await created.json()) as { conversation: { id: string } }

    await post(`/api/agent/conversations/${conversation.id}/turns`, {
      deviceId: DEVICE,
      text: '把背景换成浅木色',
    })

    expect(await db.select().from(schema.tasks)).toEqual([])
  })
})
