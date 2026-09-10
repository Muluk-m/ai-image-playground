import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { AgentConversationView } from '@image-playground/shared'
import { eq } from 'drizzle-orm'
import { Elysia } from 'elysia'
import { completionStream, recordingAgentFetch } from '../helpers/agentStubs'

process.env.DATABASE_URL = await resetTestDatabase('agent_conversations_a297')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.UPSTREAM_OPENAI_API_KEY = ''
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../agent-operator-config.json')

// Dynamic imports keep environment setup ahead of modules that capture configuration.
const { agentRoutes } = await import('../../routes/agent')
const { setAgentFetchForTesting } = await import('../../lib/agent/model')
const { close: closeDb, db, schema } = await import('../../db/client')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')

const app = new Elysia().use(agentRoutes)
const DEVICE = 'device-abcdefgh'
const OTHER_DEVICE = 'device-zzzzzzzz'

async function request(
  method: string,
  path: string,
  options: { body?: unknown; cookie?: string } = {},
) {
  const headers: Record<string, string> = {}
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  if (options.cookie) headers.cookie = options.cookie
  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    }),
  )
  return { status: response.status, json: (await response.json().catch(() => null)) as unknown }
}

async function startConversation(deviceId = DEVICE, cookie?: string): Promise<string> {
  const { status, json } = await request('POST', '/api/agent/conversations', {
    body: { deviceId },
    cookie,
  })
  expect(status).toBe(200)
  return (json as { conversation: AgentConversationView }).conversation.id
}

async function runTurn(conversationId: string, text: string, deviceId = DEVICE, cookie?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (cookie) headers.cookie = cookie
  const response = await app.handle(
    new Request(`http://localhost/api/agent/conversations/${conversationId}/turns`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ deviceId, text }),
    }),
  )
  await response.text()
  return response.status
}

async function listConversations(
  deviceId = DEVICE,
  cookie?: string,
): Promise<AgentConversationView[]> {
  const { status, json } = await request(
    'GET',
    `/api/agent/conversations?deviceId=${deviceId}`,
    cookie ? { cookie } : {},
  )
  expect(status).toBe(200)
  return (json as { conversations: AgentConversationView[] }).conversations
}

/** 两轮之间的毫秒差不保证，排序断言要自己把 updated_at 拉开。 */
async function stampUpdatedAt(conversationId: string, updatedAt: number): Promise<void> {
  await db
    .update(schema.agent_conversations)
    .set({ updated_at: updatedAt })
    .where(eq(schema.agent_conversations.id, conversationId))
}

async function signIn(userId: string): Promise<string> {
  const now = Date.now()
  await db.insert(schema.users).values({
    id: userId,
    username: userId,
    password_hash: 'fixture-hash',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
  const token = await db.transaction((tx) => createUserSession(userId, tx))
  return `${USER_SESSION_COOKIE}=${token}`
}

beforeEach(async () => {
  await db.delete(schema.agent_conversations)
  await db.delete(schema.users)
  setAgentFetchForTesting(recordingAgentFetch([], () => completionStream('好')))
})

afterEach(() => {
  setAgentFetchForTesting()
})

afterAll(async () => {
  await closeDb()
})

describe('GET /api/agent/conversations', () => {
  it('lists the identity own conversations newest first', async () => {
    const first = await startConversation()
    await runTurn(first, '第一件事')
    const second = await startConversation()
    await runTurn(second, '第二件事')
    await stampUpdatedAt(first, 1_000)
    await stampUpdatedAt(second, 2_000)

    const conversations = await listConversations()

    expect(conversations.map((one) => one.id)).toEqual([second, first])
    expect(conversations.map((one) => one.title)).toEqual(['第二件事', '第一件事'])
  })

  it('hides conversations of another device', async () => {
    const mine = await startConversation()
    await runTurn(mine, '我的')
    const theirs = await startConversation(OTHER_DEVICE)
    await runTurn(theirs, '别人的', OTHER_DEVICE)

    expect((await listConversations()).map((one) => one.id)).toEqual([mine])
    expect((await listConversations(OTHER_DEVICE)).map((one) => one.id)).toEqual([theirs])
  })

  it('hides the conversations of the device once signed in', async () => {
    const anonymous = await startConversation()
    await runTurn(anonymous, '匿名的')
    const cookie = await signIn('user-1')

    expect(await listConversations(DEVICE, cookie)).toEqual([])
  })
})

describe('DELETE /api/agent/conversations/:id', () => {
  it('leaves a tombstone and drops the conversation from the list', async () => {
    const conversationId = await startConversation()
    await runTurn(conversationId, '试错的一轮')

    const { status } = await request('DELETE', `/api/agent/conversations/${conversationId}`, {
      body: { deviceId: DEVICE },
    })

    expect(status).toBe(200)
    expect(await listConversations()).toEqual([])

    const [row] = await db.select().from(schema.agent_conversations)
    expect(row!.deleted_at).toBeGreaterThan(0)

    const messages = await request(
      'GET',
      `/api/agent/conversations/${conversationId}/messages?deviceId=${DEVICE}`,
    )
    expect(messages.status).toBe(404)
  })

  it('refuses a conversation of another device', async () => {
    const conversationId = await startConversation()

    const { status } = await request('DELETE', `/api/agent/conversations/${conversationId}`, {
      body: { deviceId: OTHER_DEVICE },
    })

    expect(status).toBe(404)
    expect(await listConversations()).toHaveLength(1)
  })
})

describe('POST /api/agent/conversations/adopt', () => {
  it('moves the device conversations to the user and is idempotent', async () => {
    const first = await startConversation()
    await runTurn(first, '登录前的第一件事')
    const second = await startConversation()
    await runTurn(second, '登录前的第二件事')
    await stampUpdatedAt(first, 1_000)
    await stampUpdatedAt(second, 2_000)
    const cookie = await signIn('user-1')

    const adoption = await request('POST', '/api/agent/conversations/adopt', {
      body: { deviceId: DEVICE },
      cookie,
    })
    expect(adoption.status).toBe(200)
    expect(adoption.json).toEqual({ adopted: 2 })

    expect((await listConversations(DEVICE, cookie)).map((one) => one.id)).toEqual([second, first])
    // 领养后设备名下不再有会话，所以重跑不产生第二份。
    expect(await listConversations()).toEqual([])

    const again = await request('POST', '/api/agent/conversations/adopt', {
      body: { deviceId: DEVICE },
      cookie,
    })
    expect(again.json).toEqual({ adopted: 0 })
    expect(await listConversations(DEVICE, cookie)).toHaveLength(2)
  })

  it('does not touch the conversations of another device', async () => {
    const theirs = await startConversation(OTHER_DEVICE)
    await runTurn(theirs, '别人的', OTHER_DEVICE)
    const cookie = await signIn('user-1')

    const adoption = await request('POST', '/api/agent/conversations/adopt', {
      body: { deviceId: DEVICE },
      cookie,
    })

    expect(adoption.json).toEqual({ adopted: 0 })
    expect((await listConversations(OTHER_DEVICE)).map((one) => one.id)).toEqual([theirs])
  })

  it('refuses an anonymous caller', async () => {
    const { status } = await request('POST', '/api/agent/conversations/adopt', {
      body: { deviceId: DEVICE },
    })

    expect(status).toBe(401)
  })
})
