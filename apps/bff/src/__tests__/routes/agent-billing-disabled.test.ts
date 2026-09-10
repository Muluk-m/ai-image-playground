import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { AgentTurnEndEvent, AgentTurnStartEvent } from '@image-playground/shared'
import { Elysia } from 'elysia'
import { _setPrivateBffOverlayForTesting } from '../../lib/private-overlay'
import { completionStream, parseFrames, recordingAgentFetch } from '../helpers/agentStubs'
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

beforeEach(async () => {
  billing.reset()
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
})
