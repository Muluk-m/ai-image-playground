import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { type AgentConversationView, DEVICE_ID_HEADER } from '@image-playground/shared'
import { eq } from 'drizzle-orm'
import { Elysia } from 'elysia'
import sharp from 'sharp'
import { completionStream, recordingAgentFetch } from '../helpers/agentStubs'
import { silenceChatUpstream } from '../helpers/chatStubs'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { waitFor } from '../helpers/upstreamStubs'

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
const { claimConversation, conversationExecution } = await import('../../lib/agent/execution')
const { close: closeDb, db, schema } = await import('../../db/client')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
const { archiveAgentReferences } = await import('../../lib/agent/images')
const { appendAgentMessage } = await import('../../lib/agent/conversations')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')

await silenceChatUpstream()

const app = new Elysia().use(agentRoutes)
const DEVICE = 'device-abcdefgh'
const OTHER_DEVICE = 'device-zzzzzzzz'

async function request(
  method: string,
  path: string,
  options: {
    body?: unknown
    cookie?: string
    deviceId?: string
  } = {},
) {
  const headers: Record<string, string> = {}
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  if (options.deviceId) headers[DEVICE_ID_HEADER] = options.deviceId
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

/**
 * 跑完一轮：流读完之后执行租约还要一次写库才释放，删除按租约判「会话还忙」。
 * `activeTurn` 只报别的实例的租约，本实例这一轮收完就是 null，等它不够。
 */
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
  await waitFor(async () => !(await conversationExecution(conversationId)))
  return response.status
}

async function listConversations(
  deviceId = DEVICE,
  cookie?: string,
): Promise<AgentConversationView[]> {
  const { status, json } = await request('GET', '/api/agent/conversations', {
    deviceId,
    ...(cookie ? { cookie } : {}),
  })
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
  setObjectStoreForTesting(new InMemoryObjectStore())
  await db.delete(schema.agent_conversations)
  await db.delete(schema.users)
  setAgentFetchForTesting(recordingAgentFetch([], () => completionStream('好')))
})

afterEach(() => {
  setObjectStoreForTesting()
  setAgentFetchForTesting()
})

afterAll(async () => {
  await closeDb()
})

it('recovers missing list titles from the first user message without changing named conversations or empty drafts', async () => {
  const unnamed = await startConversation()
  const draft = await startConversation()
  const named = await startConversation()
  const other = await startConversation(OTHER_DEVICE)
  for (const conversationId of [unnamed, named, other]) {
    await appendAgentMessage(db, {
      conversationId,
      turnId: 'title-test',
      role: 'assistant',
      content: [{ type: 'text', text: '助手话术' }],
    })
    await appendAgentMessage(db, {
      conversationId,
      turnId: 'title-test',
      role: 'user',
      content: [{ type: 'text', text: '把手机字标换成 xm' }],
    })
  }
  await db
    .update(schema.agent_conversations)
    .set({ title: '自定义标题' })
    .where(eq(schema.agent_conversations.id, named))
  const listed = await listConversations()
  expect(listed.find((one) => one.id === unnamed)?.title).toBe('把手机字标换成 xm')
  expect(listed.find((one) => one.id === named)?.title).toBe('自定义标题')
  expect(listed.find((one) => one.id === draft)?.title).toBe('')
  expect(listed.some((one) => one.id === other)).toBe(false)
})

describe('message reference thumbnails', () => {
  it('reads the selected message snapshot in reference order and returns a bounded thumbnail', async () => {
    const conversationId = await startConversation()
    const image = await sharp({
      create: { width: 200, height: 100, channels: 3, background: '#ff0000' },
    })
      .png()
      .toBuffer()
    const references = await archiveAgentReferences(conversationId, 'reference-turn', [
      { imageId: 'first', dataUrl: `data:image/png;base64,${image.toString('base64')}` },
      {
        imageId: 'second',
        dataUrl: `data:image/png;base64,${(await sharp(image).rotate(90).png().toBuffer()).toString('base64')}`,
      },
    ])
    const message = await appendAgentMessage(db, {
      conversationId,
      turnId: 'reference-turn',
      role: 'user',
      content: [{ type: 'text', text: '[image 2]换一身衣服', references }],
    })
    const path = `/api/agent/conversations/${conversationId}/messages/${message.id}/references`
    const response = await app.handle(
      new Request(`http://localhost${path}/1`, { headers: { [DEVICE_ID_HEADER]: DEVICE } }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/webp')
    const metadata = await sharp(new Uint8Array(await response.arrayBuffer())).metadata()
    expect([metadata.width, metadata.height]).toEqual([48, 96])
    const original = await app.handle(
      new Request(`http://localhost${path}/0?variant=original`, {
        headers: { [DEVICE_ID_HEADER]: DEVICE },
      }),
    )
    expect(original.status).toBe(200)
    expect(original.headers.get('content-type')).toBe('image/png')
    const originalBytes = new Uint8Array(await original.arrayBuffer())
    expect(originalBytes).toEqual(new Uint8Array(image))
    const originalMetadata = await sharp(originalBytes).metadata()
    expect([originalMetadata.width, originalMetadata.height]).toEqual([200, 100])
    expect(original.headers.get('content-security-policy')).toContain('sandbox')
    expect((await request('GET', `${path}/2`, { deviceId: DEVICE })).status).toBe(404)
    expect((await request('GET', `${path}/-1`, { deviceId: DEVICE })).status).toBe(400)
  })

  it.each([
    'thumbnail',
    'original',
  ] as const)('keeps %s snapshots private across devices, conversations and soft deletion', async (variant) => {
    const cookie = await signIn('reference-owner')
    const conversationId = await startConversation(DEVICE, cookie)
    const otherConversation = await startConversation(DEVICE, cookie)
    const image = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#0000ff' },
    })
      .png()
      .toBuffer()
    const references = await archiveAgentReferences(conversationId, 'private-reference-turn', [
      { imageId: 'private', dataUrl: `data:image/png;base64,${image.toString('base64')}` },
    ])
    const message = await appendAgentMessage(db, {
      conversationId,
      turnId: 'private-reference-turn',
      role: 'user',
      content: [{ type: 'text', text: '[image 1]', references }],
    })
    const path = `/api/agent/conversations/${conversationId}/messages/${message.id}/references/0?variant=${variant}`
    expect((await request('GET', path, { deviceId: OTHER_DEVICE })).status).toBe(404)
    expect(
      (
        await request(
          'GET',
          `/api/agent/conversations/${otherConversation}/messages/${message.id}/references/0?variant=${variant}`,
          { deviceId: DEVICE, cookie },
        )
      ).status,
    ).toBe(404)
    expect((await request('GET', path, { deviceId: DEVICE })).status).toBe(404)
    expect((await request('GET', path, { deviceId: DEVICE, cookie })).status).toBe(200)
    const otherCookie = await signIn('reference-stranger')
    expect((await request('GET', path, { deviceId: DEVICE, cookie: otherCookie })).status).toBe(404)
    await db
      .update(schema.agent_messages)
      .set({ deleted_at: Date.now() })
      .where(eq(schema.agent_messages.id, message.id))
    expect((await request('GET', path, { deviceId: DEVICE, cookie })).status).toBe(404)
  })
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

  it('refuses the device id in the query string', async () => {
    // 设备标识是纯 bearer，query string 会进访问日志 / 代理日志 / 浏览器历史。
    const { status } = await request('GET', `/api/agent/conversations?deviceId=${DEVICE}`)

    expect(status).toBe(400)
  })

  it('hides the conversations of the device once signed in', async () => {
    const anonymous = await startConversation()
    await runTurn(anonymous, '匿名的')
    const cookie = await signIn('user-1')

    expect(await listConversations(DEVICE, cookie)).toEqual([])
  })
})

it('does not expose the retired conversation adoption endpoint', async () => {
  const { status } = await request('POST', '/api/agent/conversations/adopt', {
    body: { deviceId: DEVICE },
  })
  expect(status).toBe(404)
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

    const messages = await request('GET', `/api/agent/conversations/${conversationId}/messages`, {
      deviceId: DEVICE,
    })
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

  it('上一轮刚收尾、租约还没还回来时照样能删：那不叫忙', async () => {
    const conversationId = await startConversation()
    await runTurn(conversationId, '收尾的一轮')
    const [turn] = await db
      .select()
      .from(schema.agent_turns)
      .where(eq(schema.agent_turns.conversation_id, conversationId))
    expect(turn).toBeDefined()
    // 复现终帧已经发出、租约还没异步还回去的那一瞬：页脚在，租约行仍是 running。
    expect(await claimConversation(conversationId, turn!.turn_id)).toBe(true)
    expect(await conversationExecution(conversationId)).toBeDefined()

    const { status } = await request('DELETE', `/api/agent/conversations/${conversationId}`, {
      body: { deviceId: DEVICE },
    })

    expect(status).toBe(200)
    expect(await listConversations()).toEqual([])
  })
})
