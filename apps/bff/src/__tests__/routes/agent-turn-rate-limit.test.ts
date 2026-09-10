import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { AgentConversationView } from '@image-playground/shared'
import { Elysia } from 'elysia'
import { completionStream, recordingAgentFetch } from '../helpers/agentStubs'

process.env.DATABASE_URL = await resetTestDatabase('agent_turn_rate_limit_a297')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.UPSTREAM_OPENAI_API_KEY = ''
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.CLIENT_IP_SOURCE = 'x-forwarded-for'
process.env.OPERATOR_CONFIG_FILE = resolve(
  import.meta.dir,
  '../agent-rate-limit-operator-config.json',
)

// Dynamic imports keep environment setup ahead of modules that capture configuration.
const { agentRoutes } = await import('../../routes/agent')
const { setAgentFetchForTesting } = await import('../../lib/agent/model')
const { close: closeDb, db, schema } = await import('../../db/client')

const app = new Elysia().use(agentRoutes)

async function startConversation(deviceId: string, address: string): Promise<string> {
  const response = await app.handle(
    new Request('http://localhost/api/agent/conversations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': address },
      body: JSON.stringify({ deviceId }),
    }),
  )
  expect(response.status).toBe(200)
  const body = (await response.json()) as { conversation: AgentConversationView }
  return body.conversation.id
}

async function runTurn(conversationId: string, deviceId: string, address: string) {
  const response = await app.handle(
    new Request(`http://localhost/api/agent/conversations/${conversationId}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': address },
      body: JSON.stringify({ deviceId, text: '再来一张' }),
    }),
  )
  const text = await response.text()
  return { status: response.status, text }
}

beforeEach(async () => {
  await db.delete(schema.agent_conversations)
  setAgentFetchForTesting(recordingAgentFetch([], () => completionStream('好')))
})

afterEach(() => {
  setAgentFetchForTesting()
})

afterAll(async () => {
  await closeDb()
})

describe('起一轮的速率限制', () => {
  it('设备超过每分钟阈值后拒绝', async () => {
    const device = 'device-perdevice'
    const address = '10.0.0.1'
    const conversationId = await startConversation(device, address)

    expect((await runTurn(conversationId, device, address)).status).toBe(200)
    expect((await runTurn(conversationId, device, address)).status).toBe(200)

    const blocked = await runTurn(conversationId, device, address)
    expect(blocked.status).toBe(429)
    expect(JSON.parse(blocked.text)).toEqual({ error: 'rate_limited' })
  })

  it('同一 IP 换设备也拦得住', async () => {
    const address = '10.0.0.2'
    for (let index = 0; index < 3; index++) {
      const device = `device-address${index}`
      const conversationId = await startConversation(device, address)
      expect((await runTurn(conversationId, device, address)).status).toBe(200)
    }

    const device = 'device-address3'
    const conversationId = await startConversation(device, address)
    const blocked = await runTurn(conversationId, device, address)

    expect(blocked.status).toBe(429)
    expect(JSON.parse(blocked.text)).toEqual({ error: 'rate_limited' })
  })

  it('被拦下的那一轮不落消息', async () => {
    const device = 'device-nomessage'
    const address = '10.0.0.3'
    const conversationId = await startConversation(device, address)

    await runTurn(conversationId, device, address)
    await runTurn(conversationId, device, address)
    await runTurn(conversationId, device, address)

    const messages = await app.handle(
      new Request(
        `http://localhost/api/agent/conversations/${conversationId}/messages?deviceId=${device}`,
      ),
    )
    const body = (await messages.json()) as { messages: unknown[] }
    expect(body.messages).toHaveLength(4)
  })
})
