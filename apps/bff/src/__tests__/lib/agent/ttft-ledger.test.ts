import { afterAll, describe, expect, it } from 'bun:test'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'

process.env.DATABASE_URL = await resetTestDatabase('agent_ttft_ledger')
process.env.PORT = '0'

const { createAgentUsageLedger } = await import('../../../lib/agent/usage-ledger')
const { close: closeDb, db, schema } = await import('../../../db/client')

function fakeMessage(stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    api: 'openai-completions',
    provider: 'upstream-gateway',
    model: 'claude-sonnet-4-6',
    usage: {
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 120,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  }
}

afterAll(async () => {
  await closeDb()
})

describe('createAgentUsageLedger TTFT persistence', () => {
  it('records ttft_ms on first token once and leaves ttft_ms null when no token arrives', async () => {
    const conversationId = 'conv-ttft-1'
    await db.insert(schema.agent_conversations).values({
      id: conversationId,
      device_id: 'dev-ttft',
      title: 'ttft test',
      created_at: Date.now(),
      updated_at: Date.now(),
    })

    const ledger = createAgentUsageLedger({
      conversationId,
      turnId: 'turn-1',
      userId: null,
      deviceId: 'dev-ttft',
    })

    const callOk = await ledger.begin('conversation', 'claude-sonnet-4-6')
    await ledger.dispatched(callOk, 512)
    const firstAt = Date.now() + 350
    ledger.markFirstToken(callOk, firstAt)
    // Second call must be ignored so TTFT reflects the first token, not later chunks.
    ledger.markFirstToken(callOk, firstAt + 2_000)
    await ledger.finish(callOk, fakeMessage('stop'))

    const [okRow] = await db
      .select({
        ttft_ms: schema.agent_model_calls.ttft_ms,
        status: schema.agent_model_calls.status,
      })
      .from(schema.agent_model_calls)
      .where(eq(schema.agent_model_calls.id, callOk))
    expect(okRow?.status).toBe('completed')
    expect(okRow?.ttft_ms).toBeGreaterThanOrEqual(300)
    expect(okRow?.ttft_ms).toBeLessThan(1_000)

    const callFail = await ledger.begin('conversation', 'claude-sonnet-4-6')
    await ledger.dispatched(callFail, 256)
    await ledger.finish(callFail, fakeMessage('error'))

    const [failRow] = await db
      .select({
        ttft_ms: schema.agent_model_calls.ttft_ms,
        status: schema.agent_model_calls.status,
      })
      .from(schema.agent_model_calls)
      .where(eq(schema.agent_model_calls.id, callFail))
    expect(failRow?.status).toBe('failed')
    expect(failRow?.ttft_ms).toBeNull()
  })
})
