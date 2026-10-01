import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import {
  type AgentActiveTurnView,
  type AgentMessageView,
  type AgentTurnSummaryView,
  DEVICE_ID_HEADER,
} from '@image-playground/shared'
import { sql } from 'drizzle-orm'
import { Elysia } from 'elysia'
import sharp from 'sharp'
import {
  type AgentCall,
  type ControlledCompletion,
  controlledCompletion,
  parseFrames,
  type ReceivedFrame,
  readFrames,
  recordingAgentFetch,
} from '../helpers/agentStubs'
import { silenceChatUpstream } from '../helpers/chatStubs'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { waitFor } from '../helpers/upstreamStubs'

process.env.DATABASE_URL = await resetTestDatabase('bff_agent_resume')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.UPSTREAM_OPENAI_API_KEY = ''
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../agent-operator-config.json')

const { agentRoutes } = await import('../../routes/agent')
const { setAgentFetchForTesting } = await import('../../lib/agent/model')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { createAgentImageSource } = await import('../../lib/agent/images')
const { close: closeDb, db, schema } = await import('../../db/client')

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

const opened: string[] = []

async function startConversation(): Promise<string> {
  const response = await post('/api/agent/conversations', { deviceId: DEVICE })
  const json = (await response.json()) as { conversation: { id: string } }
  opened.push(json.conversation.id)
  return json.conversation.id
}

async function drainFrames(response: Response): Promise<ReceivedFrame[]> {
  return parseFrames(await response.text())
}

function startTurn(conversationId: string, text: string): Promise<Response> {
  return post(`/api/agent/conversations/${conversationId}/turns`, { deviceId: DEVICE, text })
}

function resume(conversationId: string, turnId: string, lastEventId?: number): Promise<Response> {
  const headers = new Headers({ [DEVICE_ID_HEADER]: DEVICE })
  if (lastEventId !== undefined) headers.set('last-event-id', String(lastEventId))
  return app.handle(
    new Request(
      `http://localhost/api/agent/conversations/${conversationId}/turns/${turnId}/events`,
      { headers },
    ),
  )
}

async function readState(conversationId: string): Promise<{
  messages: AgentMessageView[]
  activeTurn: AgentActiveTurnView | null
  turns: AgentTurnSummaryView[]
}> {
  const response = await app.handle(
    new Request(`http://localhost/api/agent/conversations/${conversationId}/messages`, {
      headers: { [DEVICE_ID_HEADER]: DEVICE },
    }),
  )
  return (await response.json()) as {
    messages: AgentMessageView[]
    activeTurn: AgentActiveTurnView | null
    turns: AgentTurnSummaryView[]
  }
}

let upstream: ControlledCompletion
let calls: AgentCall[]

beforeEach(async () => {
  setObjectStoreForTesting(new InMemoryObjectStore())
  await db.delete(schema.agent_conversations)
  calls = []
  upstream = controlledCompletion()
  setAgentFetchForTesting(recordingAgentFetch(calls, (signal) => upstream.responseFor(signal)))
})

/** 轮不再绑在消费者身上，用例留下的进行中的轮必须显式收掉，否则它会写向已关闭的库。 */
afterEach(async () => {
  for (const conversationId of opened.splice(0)) {
    const { activeTurn } = await readState(conversationId)
    if (!activeTurn) continue
    await post(`/api/agent/conversations/${conversationId}/turns/${activeTurn.turnId}/abort`, {
      deviceId: DEVICE,
    })
    await waitFor(async () => (await readState(conversationId)).activeTurn === null)
  }
  setAgentFetchForTesting()
  setObjectStoreForTesting()
})

afterAll(async () => {
  await closeDb()
})

describe('断线续播', () => {
  it('重连带上 Last-Event-ID，只补断点之后的事件', async () => {
    const conversationId = await startConversation()
    const live = await startTurn(conversationId, '把背景换成浅木色')
    upstream.push('好的，')

    const seen = await readFrames(live, 3)
    expect(seen.map((frame) => frame.event.type)).toEqual([
      'turnStart',
      'assistantStart',
      'textDelta',
    ])
    expect(seen.map((frame) => frame.id)).toEqual([1, 2, 3])

    const turnStart = seen[0]!.event
    const turnId = turnStart.type === 'turnStart' ? turnStart.turnId : ''

    const resumed = resume(conversationId, turnId, seen.at(-1)!.id)
    upstream.push('我把背景换成浅木色')
    upstream.finish()

    const rest = await drainFrames(await resumed)
    expect(rest.map((frame) => frame.id)).toEqual([4, 5])
    expect(rest.map((frame) => frame.event.type)).toEqual(['textDelta', 'turnEnd'])

    const { messages } = await readState(conversationId)
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(messages[1]!.content).toEqual([{ type: 'text', text: '好的，我把背景换成浅木色' }])
  })

  it('轮跑完之后重连两次拿到同一段尾巴', async () => {
    const conversationId = await startConversation()
    const live = await startTurn(conversationId, '你好')
    upstream.push('好的')
    upstream.finish()
    const frames = await drainFrames(live)
    const turnStart = frames[0]!.event
    const turnId = turnStart.type === 'turnStart' ? turnStart.turnId : ''

    const first = await drainFrames(await resume(conversationId, turnId, 2))
    const second = await drainFrames(await resume(conversationId, turnId, 2))

    expect(first.map((frame) => frame.id)).toEqual([3, 4])
    expect(second).toEqual(first)
  })

  it('从头重连拿到整轮，刷新后的页面据此重建', async () => {
    const conversationId = await startConversation()
    const live = await startTurn(conversationId, '你好')
    upstream.push('好的')

    await readFrames(live, 3)
    const { activeTurn } = await readState(conversationId)
    expect(activeTurn).not.toBeNull()

    const replayed = resume(conversationId, activeTurn!.turnId)
    upstream.finish()

    const frames = await drainFrames(await replayed)
    expect(frames.map((frame) => frame.id)).toEqual([1, 2, 3, 4])
    expect(await readState(conversationId).then((state) => state.activeTurn)).toBeNull()
  })

  it('不认识的轮回 404', async () => {
    const conversationId = await startConversation()

    expect((await resume(conversationId, 'turn-does-not-exist')).status).toBe(404)
  })
})

describe('中止', () => {
  it('中止进行中的轮，已经流出去的文字留在历史里，刷新读回仍标着已停止', async () => {
    const conversationId = await startConversation()
    const live = await startTurn(conversationId, '画一只猫')
    upstream.push('好的，我先')
    const seen = await readFrames(live, 3)
    const turnStart = seen[0]!.event
    const turnId = turnStart.type === 'turnStart' ? turnStart.turnId : ''

    const resumed = resume(conversationId, turnId, seen.at(-1)!.id)
    const aborted = await post(`/api/agent/conversations/${conversationId}/turns/${turnId}/abort`, {
      deviceId: DEVICE,
    })
    expect(aborted.status).toBe(200)

    const rest = await drainFrames(await resumed)
    const end = rest.at(-1)!.event
    expect(end).toMatchObject({ type: 'turnEnd', turnId, stopReason: 'aborted' })

    const { messages, activeTurn, turns } = await readState(conversationId)
    expect(activeTurn).toBeNull()
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(messages[1]!.content).toEqual([{ type: 'text', text: '好的，我先' }])
    expect(turns).toEqual([expect.objectContaining({ turnId, stopReason: 'aborted' })])
  })

  it('轮已经结束时中止回 404', async () => {
    const conversationId = await startConversation()
    const live = await startTurn(conversationId, '你好')
    upstream.push('好的')
    upstream.finish()
    const frames = await drainFrames(live)
    const turnStart = frames[0]!.event
    const turnId = turnStart.type === 'turnStart' ? turnStart.turnId : ''

    const response = await post(
      `/api/agent/conversations/${conversationId}/turns/${turnId}/abort`,
      { deviceId: DEVICE },
    )

    expect(response.status).toBe(404)
  })
})

describe('失败', () => {
  it('上游流到一半报错，半截回复不进历史', async () => {
    const conversationId = await startConversation()
    const live = await startTurn(conversationId, '画一只猫')
    upstream.push('好的，我先')
    const seen = await readFrames(live, 3)
    const turnStart = seen[0]!.event
    const turnId = turnStart.type === 'turnStart' ? turnStart.turnId : ''

    const resumed = resume(conversationId, turnId, seen.at(-1)!.id)
    upstream.fail()

    const rest = await drainFrames(await resumed)
    const end = rest.at(-1)!.event
    expect(end).toMatchObject({ type: 'turnEnd', turnId, stopReason: 'failed' })

    // 面板在 turnEnd failed 时撤掉这段没收尾的文字，历史里也不能留着它。
    const { messages, activeTurn } = await readState(conversationId)
    expect(activeTurn).toBeNull()
    expect(messages.map((message) => message.role)).toEqual(['user'])
    expect(messages[0]!.content).toEqual([{ type: 'text', text: '画一只猫' }])
  })
})

describe('插话', () => {
  it('助手收尾期间迟到的插话明确拒绝，不保存幽灵消息或额外调用模型', async () => {
    const conversationId = await startConversation()
    const live = await startTurn(conversationId, '先聊聊')
    upstream.push('收到')
    const seen = await readFrames(live, 3)
    const start = seen[0]!.event
    const turnId = start.type === 'turnStart' ? start.turnId : ''
    const resumed = resume(conversationId, turnId, seen.at(-1)!.id)
    const second = controlledCompletion()
    const hold = async (key: number) => {
      let release!: () => void
      let acquired!: () => void
      const released = new Promise<void>((resolve) => {
        release = resolve
      })
      const locked = new Promise<void>((resolve) => {
        acquired = resolve
      })
      const holding = db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${key})`)
        acquired()
        await released
      })
      await locked
      return async () => {
        release()
        await holding
      }
    }
    const waitBlocked = (key: number) =>
      waitFor(async () => {
        const rows = await db.execute(
          sql`SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND objid = ${key}::oid AND NOT granted`,
        )
        return rows.length > 0
      })
    const releaseAssistant = await hold(8731043)
    await db.execute(sql`CREATE FUNCTION hold_interjection_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.role = 'assistant' THEN
          PERFORM pg_advisory_xact_lock(8731043);
        END IF;
        RETURN NEW;
      END $$`)
    await db.execute(
      sql`CREATE TRIGGER hold_interjection_write BEFORE INSERT ON agent_messages FOR EACH ROW EXECUTE FUNCTION hold_interjection_write()`,
    )
    let releaseArchive!: () => void
    let archiving!: () => void
    const archived = new Promise<void>((resolve) => {
      archiving = resolve
    })
    const archiveGate = new Promise<void>((resolve) => {
      releaseArchive = resolve
    })
    class DelayedArchive extends InMemoryObjectStore {
      override async write(
        key: string,
        bytes: Uint8Array,
        contentType: string,
        signal?: AbortSignal,
      ) {
        if (key.includes('/interjections/')) {
          archiving()
          await archiveGate
        }
        await super.write(key, bytes, contentType, signal)
      }
    }
    setObjectStoreForTesting(new DelayedArchive())
    const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#cccccc' } })
      .png()
      .toBuffer()
    const interjected = post(
      `/api/agent/conversations/${conversationId}/turns/${turnId}/interject`,
      {
        deviceId: DEVICE,
        clientMessageId: 'late-commit',
        text: '改成狗',
        references: [
          { imageId: 'new-reference', dataUrl: `data:image/png;base64,${png.toString('base64')}` },
        ],
      },
    )
    try {
      await archived
      setAgentFetchForTesting(recordingAgentFetch(calls, (signal) => second.responseFor(signal)))
      upstream.finish()
      await waitBlocked(8731043)
      releaseArchive()
      // Flush the admission's promise continuations while the previous message write is held.
      await new Promise<void>((resolve) => setImmediate(resolve))
      await releaseAssistant()
      const response = await interjected
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ error: 'turn_finished' })
      expect((await drainFrames(await resumed)).at(-1)!.event).toMatchObject({
        type: 'turnEnd',
        stopReason: 'completed',
      })
      expect(calls).toHaveLength(1)
      const { messages } = await readState(conversationId)
      expect(messages.map((message) => message.role)).toEqual(['user', 'assistant'])
      expect(messages[0]!.content).toEqual([{ type: 'text', text: '先聊聊' }])
      expect(messages[1]!.content).toEqual([{ type: 'text', text: '收到' }])
    } finally {
      releaseArchive()
      await releaseAssistant()
      await interjected
      if (calls.length > 1) second.finish()
      await db.execute(sql`DROP TRIGGER hold_interjection_write ON agent_messages`)
      await db.execute(sql`DROP FUNCTION hold_interjection_write()`)
    }
  })

  it('插话提前保存过助手片段后上游失败，刷新历史仍不保留半截回复', async () => {
    const conversationId = await startConversation()
    const live = await startTurn(conversationId, '画一只猫')
    upstream.push('好的，我先')
    const seen = await readFrames(live, 3)
    const start = seen[0]!.event
    const turnId = start.type === 'turnStart' ? start.turnId : ''
    const resumed = resume(conversationId, turnId, seen.at(-1)!.id)
    const interjected = await post(
      `/api/agent/conversations/${conversationId}/turns/${turnId}/interject`,
      { deviceId: DEVICE, text: '改成狗' },
    )
    expect(interjected.status).toBe(200)
    upstream.fail()
    const rest = await drainFrames(await resumed)
    expect(rest.at(-1)!.event).toMatchObject({ type: 'turnEnd', stopReason: 'failed' })
    const { messages, activeTurn } = await readState(conversationId)
    expect(activeTurn).toBeNull()
    expect(messages.map((message) => message.role)).toEqual(['user', 'user'])
    expect(messages[1]!.content).toEqual([{ type: 'text', text: '改成狗' }])
  })

  it('新参考图与遮罩随插话归档，模型可见，下一轮仍可改图', async () => {
    const second = controlledCompletion()
    const conversationId = await startConversation()
    const live = await startTurn(conversationId, '先聊聊')
    upstream.push('好的')
    const seen = await readFrames(live, 3)
    const start = seen[0]!.event
    const turnId = start.type === 'turnStart' ? start.turnId : ''
    const resumed = resume(conversationId, turnId, seen.at(-1)!.id)
    const reference = {
      imageId: 'new-image',
      dataUrl: `data:image/png;base64,${(
        await sharp({ create: { width: 2, height: 2, channels: 4, background: '#ffffff' } })
          .png()
          .toBuffer()
      ).toString('base64')}`,
      maskDataUrl: `data:image/png;base64,${(
        await sharp({ create: { width: 2, height: 2, channels: 4, background: '#00000000' } })
          .png()
          .toBuffer()
      ).toString('base64')}`,
    }
    const interjected = await post(
      `/api/agent/conversations/${conversationId}/turns/${turnId}/interject`,
      {
        deviceId: DEVICE,
        text: '修改 [image 1]',
        references: [reference],
      },
    )
    expect(interjected.status).toBe(200)
    setAgentFetchForTesting(recordingAgentFetch(calls, (signal) => second.responseFor(signal)))
    upstream.finish()
    await waitFor(() => calls.length === 2)
    expect(JSON.stringify(calls[1]!.messages.at(-1))).toContain('new-image')
    expect(JSON.stringify(calls[1]!.messages.at(-1))).toContain('data:image/png;base64,')
    second.push('收到图片')
    second.finish()
    await drainFrames(await resumed)
    const { messages } = await readState(conversationId)
    const block = messages.find(
      (message) => message.role === 'user' && JSON.stringify(message.content).includes('new-image'),
    )!.content[0]!
    const stored = block.type === 'text' ? block.references?.[0] : undefined
    expect(stored && 'mask' in stored && stored.mask).toBeTruthy()
    expect(JSON.stringify(block)).not.toContain('data:image')
    const source = createAgentImageSource({
      references: [],
      history: messages,
      conversationId,
      userId: null,
    })
    expect(await source.resolve('image 1')).toEqual({
      imageId: reference.imageId,
      dataUrl: reference.dataUrl,
      visualVariant: 'original',
    })
    const continuation = createAgentImageSource({
      references: [],
      history: messages,
      conversationId,
      userId: null,
      selectionHistoryStart: 0,
    })
    expect(await continuation.resolve('image 1')).toEqual({
      ...reference,
      visualVariant: 'original',
    })
  })

  it('轮进行中追加一条用户消息，运行时接着它往下跑', async () => {
    const second = controlledCompletion()
    const conversationId = await startConversation()
    const live = await startTurn(conversationId, '画一只猫')
    upstream.push('好的')
    const seen = await readFrames(live, 3)
    const turnStart = seen[0]!.event
    const turnId = turnStart.type === 'turnStart' ? turnStart.turnId : ''

    const resumed = resume(conversationId, turnId, seen.at(-1)!.id)
    const interjected = await post(
      `/api/agent/conversations/${conversationId}/turns/${turnId}/interject`,
      { deviceId: DEVICE, text: '改成狗' },
    )
    expect(interjected.status).toBe(200)

    setAgentFetchForTesting(recordingAgentFetch(calls, (signal) => second.responseFor(signal)))
    upstream.finish()
    await waitFor(() => calls.length === 2)
    second.push('好，改成狗')
    second.finish()

    const rest = await drainFrames(await resumed)
    expect(rest.map((frame) => frame.event.type)).toEqual([
      'interjection',
      'assistantStart',
      'textDelta',
      'turnEnd',
    ])
    expect(calls[1]!.messages.at(-1)).toMatchObject({ role: 'user' })

    const { messages } = await readState(conversationId)
    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ])
    expect(messages.map((message) => message.turnId)).toEqual([turnId, turnId, turnId, turnId])
  })

  it('轮已经结束时插话回 404', async () => {
    const conversationId = await startConversation()
    const live = await startTurn(conversationId, '你好')
    upstream.push('好的')
    upstream.finish()
    const frames = await drainFrames(live)
    const turnStart = frames[0]!.event
    const turnId = turnStart.type === 'turnStart' ? turnStart.turnId : ''

    const response = await post(
      `/api/agent/conversations/${conversationId}/turns/${turnId}/interject`,
      { deviceId: DEVICE, text: '改成狗' },
    )

    expect(response.status).toBe(404)
  })
})

describe('并发', () => {
  it('同一个会话已经有轮在跑时不再起第二轮，这句话排进队、带上在跑的那一轮', async () => {
    const conversationId = await startConversation()
    const live = await startTurn(conversationId, '你好')
    upstream.push('好的')
    const opening = await readFrames(live, 3)
    const turnStart = opening[0]!.event
    const turnId = turnStart.type === 'turnStart' ? turnStart.turnId : ''

    const second = await startTurn(conversationId, '再来一句')

    expect(second.status).toBe(202)
    // 另一个标签页据此挂回这一轮，而不是把它当失败报错；它那句话排在这一轮之后。
    expect(await second.json()).toMatchObject({
      state: 'pending',
      turnId,
      queued: { text: '再来一句' },
    })
    await db.delete(schema.agent_inbox)
    upstream.finish()
  })
})
