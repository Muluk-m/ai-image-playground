import { afterAll, afterEach, beforeEach, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import {
  AGENT_TURN_ATTACHED_MEDIA_MAX,
  AGENT_TURN_MAX_INLINE_REFERENCES,
  AGENT_TURN_MAX_REFERENCES,
  type AgentTurnReference,
} from '@image-playground/shared'
import { and, eq } from 'drizzle-orm'
import { Elysia } from 'elysia'
import {
  type AgentCall,
  type ControlledCompletion,
  completionStream,
  controlledCompletion,
  recordingAgentFetch,
} from '../helpers/agentStubs'
import { silenceChatUpstream } from '../helpers/chatStubs'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { waitFor } from '../helpers/upstreamStubs'

/**
 * 一轮带多少张参考图、其中几张的内容真发出去，是两件事。用户在画布上圈几十张是常事：
 * 张数放宽靠的是「按 id 发、字节不进请求体」，模型拿到的是一份清单，要看内容自己调 viewImage。
 * 这里钉的就是那条分界——哪几张进上游请求的图片块、清单怎么写、超了多少当坏请求打回。
 */

process.env.DATABASE_URL = await resetTestDatabase('bff_agent_turn_references')
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
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { setDurableMediaStoreForTesting } = await import('../../lib/durableMediaStore')

await silenceChatUpstream()

const app = new Elysia().use(agentRoutes)
const DEVICE = 'device-abcdefgh'
const USER_ID = 'agent-reference-user'
const PIXEL = 'data:image/png;base64,aGk='

class DurableFixture extends InMemoryObjectStore {
  sign(key: string) {
    return `https://durable.example/${key}`
  }
}
let durable: DurableFixture
let sessionToken = ''

async function post(path: string, body: unknown) {
  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `${USER_SESSION_COOKIE}=${sessionToken}`,
      },
      body: JSON.stringify(body),
    }),
  )
  return { status: response.status, payload: await response.text() }
}

async function startConversation(): Promise<string> {
  const { status, payload } = await post('/api/agent/conversations', { deviceId: DEVICE })
  expect(status).toBe(200)
  return (JSON.parse(payload) as { conversation: { id: string } }).conversation.id
}

function runTurn(
  conversationId: string,
  text: string,
  references: readonly AgentTurnReference[],
): Promise<{ status: number; payload: string }> {
  return post(`/api/agent/conversations/${conversationId}/turns`, {
    deviceId: DEVICE,
    text,
    references,
  })
}

/** 正在跑的那一轮的 id：插话按它寻址，而这一轮的 SSE 还没读完，拿不到首帧。 */
async function runningTurnId(conversationId: string): Promise<string> {
  let turnId: string | undefined
  await waitFor(async () => {
    const [running] = await db
      .select()
      .from(schema.agent_executions)
      .where(
        and(
          eq(schema.agent_executions.conversation_id, conversationId),
          eq(schema.agent_executions.state, 'running'),
        ),
      )
    turnId = running?.turn_id
    return turnId !== undefined
  }, 5_000)
  if (!turnId) throw new Error('no running turn')
  return turnId
}

/** 送上游的那一条用户消息拆成两半：真带着字节的图片块，和纯文字。 */
function sentBlocks(call: AgentCall): { readonly images: string[]; readonly text: string } {
  const content = call.messages.at(-1)?.content
  if (!Array.isArray(content)) throw new Error('the turn prompt should be a block list')
  const images: string[] = []
  let text = ''
  for (const block of content) {
    if (!block || typeof block !== 'object' || !('type' in block)) continue
    if (block.type === 'image_url') images.push(String(block.image_url?.url ?? ''))
    else if (block.type === 'text' && typeof block.text === 'string') text += block.text
  }
  return { images, text }
}

/** 一张已经上传完的画布图片。原件与预览给不同字节，断言才分得清取回来的是哪一份。 */
async function media(at: number): Promise<AgentTurnReference> {
  const id = `11111111-2222-4333-8444-${String(at).padStart(12, '0')}`
  const now = Date.now()
  await durable.write(`media/${id}`, new TextEncoder().encode(`orig-${at}`), 'image/png')
  await durable.write(`preview/${id}`, new TextEncoder().encode(`prev-${at}`), 'image/webp')
  await db.insert(schema.media_objects).values({
    id,
    user_id: USER_ID,
    sha256: `sha-${id}`,
    bytes: 7,
    content_type: 'image/png',
    status: 'ready',
    reserved_bytes: 0,
    staging_key: `staging/${id}`,
    object_key: `media/${id}`,
    preview_key: `preview/${id}`,
    expires_at: now + 86_400_000,
    created_at: now,
    updated_at: now,
  })
  return { imageId: id, mediaId: id }
}

function mediaBatch(count: number): Promise<AgentTurnReference[]> {
  return Promise.all(Array.from({ length: count }, (_, at) => media(at)))
}

const base64 = (value: string) => Buffer.from(value).toString('base64')

beforeEach(async () => {
  durable = new DurableFixture()
  setDurableMediaStoreForTesting(durable)
  setObjectStoreForTesting(new InMemoryObjectStore())
  await db.delete(schema.agent_conversations)
  await db.delete(schema.media_references)
  await db.delete(schema.media_objects)
  await db.delete(schema.user_sessions)
  await db.delete(schema.users)
  const now = Date.now()
  await db.insert(schema.users).values({
    id: USER_ID,
    username: 'agent.references',
    password_hash: 'fixture-hash',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
  sessionToken = await db.transaction((tx) => createUserSession(USER_ID, tx))
})

afterEach(() => {
  setAgentFetchForTesting()
  setObjectStoreForTesting()
  setDurableMediaStoreForTesting()
})

afterAll(async () => {
  await closeDb()
})

it('lists a large canvas selection without sending any of its bytes', async () => {
  const calls: AgentCall[] = []
  setAgentFetchForTesting(recordingAgentFetch(calls, () => completionStream('好的')))
  const conversationId = await startConversation()
  const references = await mediaBatch(AGENT_TURN_ATTACHED_MEDIA_MAX + 2)

  expect((await runTurn(conversationId, '[image 1] 这几张都参考一下', references)).status).toBe(200)

  const sent = sentBlocks(calls[0]!)
  expect(sent.images).toEqual([])
  // 编号按请求顺序数，用户那句话里的 `[image N]` 指的就是这一个。
  for (const [at, reference] of references.entries())
    expect(sent.text).toContain(`[image ${at + 1}] 图片 id ${reference.imageId}`)
  expect(sent.text).toContain('本轮用户选中的图')
  expect(sent.text).toContain('内容没有附在本轮输入里')
  expect(sent.text).toContain('viewImage')
  // 一张字节都没发，就不该有视觉证据那一段。
  expect(sent.text).not.toContain('视觉证据')
})

it('shows a small canvas selection as preview images', async () => {
  const calls: AgentCall[] = []
  setAgentFetchForTesting(recordingAgentFetch(calls, () => completionStream('好的')))
  const conversationId = await startConversation()
  const references = await mediaBatch(2)

  expect((await runTurn(conversationId, '[image 1] 这两张合一下', references)).status).toBe(200)

  const sent = sentBlocks(calls[0]!)
  expect(sent.images).toHaveLength(2)
  // 看一眼判断「是不是那张图」用预留的预览就够，原件一次几 MB。
  expect(sent.images[0]).toBe(`data:image/webp;base64,${base64('prev-0')}`)
  expect(sent.images[1]).toBe(`data:image/webp;base64,${base64('prev-1')}`)
  expect(sent.text).toContain('已附在本轮输入里')
  expect(sent.text).toContain(`视觉输入 1：图片 ${references[0]!.imageId} 原图`)
})

it('sends the inline reference of a mixed turn and only lists the canvas ones', async () => {
  const calls: AgentCall[] = []
  setAgentFetchForTesting(recordingAgentFetch(calls, () => completionStream('好的')))
  const conversationId = await startConversation()
  const selected = await mediaBatch(AGENT_TURN_ATTACHED_MEDIA_MAX + 2)
  const dropped = { imageId: 'dropped-file', dataUrl: PIXEL }
  const references: AgentTurnReference[] = [dropped, ...selected]
  const turn = await runTurn(conversationId, '[image 1] 按这张的风格改其余几张', references)

  expect(turn.status).toBe(200)

  const sent = sentBlocks(calls[0]!)
  expect(sent.images).toEqual([PIXEL])
  expect(sent.text).toContain('[image 1] 图片 id dropped-file（内容已附在本轮输入里）')
  for (const [at, reference] of selected.entries()) {
    expect(sent.text).toContain(`[image ${at + 2}] 图片 id ${reference.imageId}`)
    expect(sent.text).not.toContain(`${reference.imageId}（内容已附在本轮输入里）`)
  }
})

it('refuses more inline references than one turn carries, but takes a full batch of ids', async () => {
  setAgentFetchForTesting(recordingAgentFetch([], () => completionStream('好的')))
  const conversationId = await startConversation()
  const inline = Array.from({ length: AGENT_TURN_MAX_INLINE_REFERENCES + 1 }, (_, at) => ({
    imageId: `file-${at}`,
    dataUrl: PIXEL,
  }))

  const refused = await runTurn(conversationId, '都参考一下', inline)
  expect(refused.status).toBe(422)
  expect(JSON.parse(refused.payload)).toEqual({ error: 'invalid_reference' })

  const media = await mediaBatch(AGENT_TURN_MAX_REFERENCES)
  const accepted = await runTurn(conversationId, '都参考一下', media)
  expect(accepted.status).toBe(200)
})

/** 插话与首轮走的是两条解析路径，同一条规则要在两边都成立。 */
it('lists a large selection that arrives as an interjection, and sends none of its bytes', async () => {
  const calls: AgentCall[] = []
  const upstreams: ControlledCompletion[] = []
  setAgentFetchForTesting(
    recordingAgentFetch(calls, (signal) => {
      const upstream = controlledCompletion()
      upstreams.push(upstream)
      return upstream.responseFor(signal)
    }),
  )
  const conversationId = await startConversation()
  const references = await mediaBatch(AGENT_TURN_ATTACHED_MEDIA_MAX + 2)
  // 这一轮卡在上游流上，插话才赶得上它。
  const running = post(`/api/agent/conversations/${conversationId}/turns`, {
    deviceId: DEVICE,
    text: '先别动',
  })
  await waitFor(() => upstreams.length > 0, 3_000)
  const turnId = await runningTurnId(conversationId)

  const interjected = await post(
    `/api/agent/conversations/${conversationId}/turns/${turnId}/interject`,
    { deviceId: DEVICE, text: '[image 1] 这几张都参考一下', references },
  )
  expect(interjected.status).toBe(200)

  upstreams[0]!.push('好的')
  upstreams[0]!.finish()
  await waitFor(() => upstreams.length > 1, 3_000)

  const steered = sentBlocks(calls[1]!)
  expect(steered.images).toEqual([])
  for (const [at, reference] of references.entries())
    expect(steered.text).toContain(`[image ${at + 1}] 图片 id ${reference.imageId}`)
  expect(steered.text).toContain('本轮用户选中的图')

  upstreams[1]!.push('都收到了')
  upstreams[1]!.finish()
  expect((await running).status).toBe(200)
})
