import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'

process.env.PORT = '0'
process.env.DATABASE_URL = 'postgres://unused/unused'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.OPERATOR_CONFIG_FILE = ''

// Dynamic imports keep environment setup ahead of modules that capture configuration.
const { agentRoutes } = await import('../../routes/agent')
const { setAgentFetchForTesting } = await import('../../lib/agent/model')

const app = new Elysia().use(agentRoutes)

describe('the agent routes without the capability', () => {
  it('answers 404 before any identity or model work', async () => {
    setAgentFetchForTesting(() => {
      throw new Error('unexpected agent call')
    })

    const response = await app.handle(
      new Request('http://localhost/api/agent/conversations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: 'device-abcdefgh' }),
      }),
    )

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: 'capability_unavailable',
      capability: 'agent:chat',
    })
    setAgentFetchForTesting()
  })
})
