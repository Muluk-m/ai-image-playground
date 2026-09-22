import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { type AgentConversationView, DEVICE_ID_HEADER } from '@image-playground/shared'
import { eq } from 'drizzle-orm'
import { Elysia } from 'elysia'
import sharp from 'sharp'
import { completionStream, recordingAgentFetch } from '../helpers/agentStubs'
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
const { DEVICE_CLAIM_COOKIE } = await import('../../lib/agent/deviceClaim')
const { archiveAgentReferences } = await import('../../lib/agent/images')
const { appendAgentMessage, adoptDeviceConversations } = await import(
  '../../lib/agent/conversations'
)
const { setObjectStoreForTesting } = await import('../../lib/objectStore')

const app = new Elysia().use(agentRoutes)
const DEVICE = 'device-abcdefgh'
const OTHER_DEVICE = 'device-zzzzzzzz'

/**
 * 浏览器会把服务端下发的持有性证明 cookie 存起来再带回去（见 `lib/agent/deviceClaim.ts`）。
 * 测试里也照做，按设备各存一份——不带它，领养就该被拒，那正是另外几格要验的事。
 */
const deviceClaims = new Map<string, string>()

function claimOf(deviceId: string | undefined): string | undefined {
  return deviceId ? deviceClaims.get(deviceId) : undefined
}

function rememberClaim(deviceId: string | undefined, response: Response): void {
  if (!deviceId) return
  const header = response.headers.get('set-cookie')
  const match = header?.match(new RegExp(`${DEVICE_CLAIM_COOKIE}=([^;]+)`))
  if (match) deviceClaims.set(deviceId, `${DEVICE_CLAIM_COOKIE}=${match[1]}`)
}

function cookieHeader(...parts: (string | undefined)[]): string | undefined {
  const joined = parts.filter(Boolean).join('; ')
  return joined || undefined
}

async function request(
  method: string,
  path: string,
  options: {
    body?: unknown
    cookie?: string
    deviceId?: string
    /** 明确不带持有性证明：模拟另一个只知道设备标识的浏览器。 */
    withoutClaim?: boolean
  } = {},
) {
  const headers: Record<string, string> = {}
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  if (options.deviceId) headers[DEVICE_ID_HEADER] = options.deviceId
  const body = options.body as { deviceId?: string } | undefined
  const deviceId = options.deviceId ?? body?.deviceId
  const cookie = cookieHeader(options.cookie, options.withoutClaim ? undefined : claimOf(deviceId))
  if (cookie) headers.cookie = cookie
  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    }),
  )
  if (!options.withoutClaim) rememberClaim(deviceId, response)
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
  const jar = cookieHeader(cookie, claimOf(deviceId))
  if (jar) headers.cookie = jar
  const response = await app.handle(
    new Request(`http://localhost/api/agent/conversations/${conversationId}/turns`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ deviceId, text }),
    }),
  )
  rememberClaim(deviceId, response)
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
  await db.delete(schema.agent_device_claims)
  await db.delete(schema.users)
  deviceClaims.clear()
  setAgentFetchForTesting(recordingAgentFetch([], () => completionStream('好')))
})

afterEach(() => {
  setObjectStoreForTesting()
  setAgentFetchForTesting()
})

afterAll(async () => {
  await closeDb()
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
  ] as const)('keeps %s snapshots private across devices, conversations, adoption and soft deletion', async (variant) => {
    const conversationId = await startConversation()
    const otherConversation = await startConversation()
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
          { deviceId: DEVICE },
        )
      ).status,
    ).toBe(404)
    const cookie = await signIn('reference-owner')
    await adoptDeviceConversations(DEVICE, 'reference-owner')
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
    const mine = await startConversation()
    await runTurn(mine, '我的')
    const cookie = await signIn('user-1')

    const adoption = await request('POST', '/api/agent/conversations/adopt', {
      body: { deviceId: DEVICE },
      cookie,
    })

    expect(adoption.json).toEqual({ adopted: 1 })
    expect((await listConversations(OTHER_DEVICE)).map((one) => one.id)).toEqual([theirs])
  })

  /**
   * 领养不可逆：会话改挂账号后原设备再也看不到。所以它不接受自述的设备标识——
   * 一个从访问日志里捡到标识的人，拿不出起轮时下发的那张 cookie。
   */
  it('refuses a caller that only knows the device id', async () => {
    const mine = await startConversation()
    await runTurn(mine, '我的')
    const cookie = await signIn('attacker')

    const adoption = await request('POST', '/api/agent/conversations/adopt', {
      body: { deviceId: DEVICE },
      cookie,
      withoutClaim: true,
    })

    expect(adoption.status).toBe(403)
    expect((await listConversations()).map((one) => one.id)).toEqual([mine])
  })

  it('refuses a browser that declared the device id after someone else already held it', async () => {
    const mine = await startConversation()
    await runTurn(mine, '我的')
    // 第二个浏览器报同一个标识：登记行已在，不改绑，它拿到的还是空手。
    await request('GET', '/api/agent/conversations', { deviceId: DEVICE, withoutClaim: true })
    const cookie = await signIn('attacker')

    const adoption = await request('POST', '/api/agent/conversations/adopt', {
      body: { deviceId: DEVICE },
      cookie,
      withoutClaim: true,
    })

    expect(adoption.status).toBe(403)
    expect((await listConversations()).map((one) => one.id)).toEqual([mine])
  })

  it('refuses an anonymous caller', async () => {
    const { status } = await request('POST', '/api/agent/conversations/adopt', {
      body: { deviceId: DEVICE },
    })

    expect(status).toBe(401)
  })
})
