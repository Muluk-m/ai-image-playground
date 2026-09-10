import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { AgentTurnEvent } from '@image-playground/shared'
import { eq } from 'drizzle-orm'
import { Elysia } from 'elysia'
import {
  type AgentCall,
  completionStream,
  eventsOfType,
  parseFrames,
  scriptedAgentFetch,
  TEST_IMAGE_CHANNEL,
  TEST_RESULT_PAYLOAD,
  toolCallCompletion,
} from '../helpers/agentStubs'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'

process.env.DATABASE_URL = await resetTestDatabase('agent_edit_a290')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.UPSTREAM_OPENAI_API_KEY = ''
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../agent-operator-config.json')

// Dynamic imports keep environment setup ahead of modules that capture configuration.
const { agentRoutes } = await import('../../routes/agent')
const { setAgentFetchForTesting } = await import('../../lib/agent/model')
const { setQueueTaskPollingForTesting } = await import('../../lib/taskSubmission')
const { _setChannelsForTesting } = await import('../../lib/channels')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
const { close: closeDb, db, schema } = await import('../../db/client')

const app = new Elysia().use(agentRoutes)
const DEVICE = 'device-abcdefgh'

const PIXEL = 'data:image/png;base64,aGk='
const MASK = 'data:image/png;base64,bWFzaw=='

let storage: InMemoryObjectStore

async function post(path: string, body: unknown, cookie?: string) {
  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
  )
  return { status: response.status, json: await response.json() }
}

async function startConversation(cookie?: string): Promise<string> {
  const { status, json } = await post('/api/agent/conversations', { deviceId: DEVICE }, cookie)
  expect(status).toBe(200)
  return (json as { conversation: { id: string } }).conversation.id
}

interface TurnOptions {
  readonly references?: unknown[]
  readonly cookie?: string
}

async function runTurn(conversationId: string, text: string, options: TurnOptions = {}) {
  const response = await app.handle(
    new Request(`http://localhost/api/agent/conversations/${conversationId}/turns`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(options.cookie ? { cookie: options.cookie } : {}),
      },
      body: JSON.stringify({
        deviceId: DEVICE,
        text,
        ...(options.references ? { references: options.references } : {}),
      }),
    }),
  )
  return parseFrames(await response.text())
}

/** 测试里的迷你 worker：把工具刚提交的任务推到终态，让工具循环能往下跑。 */
function settleSubmittedTasks(outcome: 'completed' | 'failed'): () => void {
  let stopped = false
  void (async () => {
    while (!stopped) {
      await db
        .update(schema.tasks)
        .set(
          outcome === 'completed'
            ? { status: 'completed', result_payload: TEST_RESULT_PAYLOAD, completed_at: Date.now() }
            : { status: 'failed', error_message: '上游拒绝了这张图', error_type: 'upstream_error' },
        )
        .where(eq(schema.tasks.status, 'queued'))
      await Bun.sleep(2)
    }
  })()
  return () => {
    stopped = true
  }
}

async function createUser(id: string): Promise<string> {
  const now = Date.now()
  await db.insert(schema.users).values({
    id,
    username: id,
    password_hash: 'fixture-hash',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
  const token = await db.transaction((tx) => createUserSession(id, tx))
  return `${USER_SESSION_COOKIE}=${token}`
}

/** 一条素材记录加它的图片本体：同步之后服务端就是这个样子。 */
async function giveAsset(userId: string, name: string, imageId: string): Promise<void> {
  const now = Date.now()
  await db.insert(schema.user_assets).values({
    user_id: userId,
    id: `asset-${imageId}`,
    name,
    image_id: imageId,
    created_at: now,
    updated_at: now,
    last_used_at: now,
    version: 1,
  })
  await db.insert(schema.user_asset_objects).values({
    user_id: userId,
    image_id: imageId,
    bytes: 2,
    content_type: 'image/png',
    created_at: now,
  })
  await storage.write(`users/${userId}/assets/${imageId}`, new Uint8Array([104, 105]), 'image/png')
}

beforeEach(async () => {
  storage = new InMemoryObjectStore()
  setObjectStoreForTesting(storage)
  _setChannelsForTesting([TEST_IMAGE_CHANNEL])
  setQueueTaskPollingForTesting({ intervalMs: 2, budgetMs: 30_000 })
  await db.delete(schema.tasks)
  await db.delete(schema.agent_conversations)
  await db.delete(schema.users)
})

afterEach(() => {
  setAgentFetchForTesting()
  setQueueTaskPollingForTesting()
  setObjectStoreForTesting()
})

afterAll(async () => {
  await closeDb()
})

describe('智能体改图工具', () => {
  it('submits the referenced image and anchors the output to it', async () => {
    const calls: AgentCall[] = []
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () =>
          toolCallCompletion({
            id: 'call-1',
            name: 'editImage',
            args: { prompt: '把背景换成浅木色', imageIds: ['canvas-1'] },
          }),
        () => completionStream('改好了'),
      ]),
    )
    const stop = settleSubmittedTasks('completed')
    const conversationId = await startConversation()

    const frames = await runTurn(conversationId, '把 [image 1] 的背景换成浅木色', {
      references: [{ imageId: 'canvas-1', dataUrl: PIXEL }],
    })
    stop()

    const [end] = eventsOfType(frames, 'toolEnd')
    expect(end).toMatchObject({ toolCallId: 'call-1', status: 'succeeded' })
    // 产出贴着源图放，源图本身不进这次任务的产出。
    expect(end!.anchorObjectId).toBe('canvas-1')
    expect(end!.artifacts).toHaveLength(1)
    expect(end!.artifacts![0]!.artifactId).not.toBe('canvas-1')

    const [task] = await db.select().from(schema.tasks)
    expect(task!.request_payload.prompt).toBe('把背景换成浅木色')
    expect(task!.request_payload.input_images).toHaveLength(1)
    expect(task!.request_payload.mask).toBeUndefined()

    expect(calls[0]!.tools?.map((tool) => tool.function.name).sort()).toEqual([
      'askClarification',
      'editImage',
      'generateImage',
      'readLibrary',
    ])
  })

  it('passes the mask the user drew on that reference', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(
        [],
        [
          () =>
            toolCallCompletion({
              id: 'call-1',
              name: 'editImage',
              args: { prompt: '只改这一块', imageIds: ['canvas-1'] },
            }),
          () => completionStream('改好了'),
        ],
      ),
    )
    const stop = settleSubmittedTasks('completed')
    const conversationId = await startConversation()

    await runTurn(conversationId, '把 [image 1] 圈出来的部分改掉', {
      references: [{ imageId: 'canvas-1', dataUrl: PIXEL, maskDataUrl: MASK }],
    })
    stop()

    const [task] = await db.select().from(schema.tasks)
    expect(task!.request_payload.mask).toBeTruthy()
  })

  it('keeps the turn alive when the model names an image it cannot reach', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(
        [],
        [
          () =>
            toolCallCompletion({
              id: 'call-1',
              name: 'editImage',
              args: { prompt: '改一下', imageIds: ['not-here'] },
            }),
          () => completionStream('这张图我拿不到，请在输入框里引用它'),
        ],
      ),
    )
    const conversationId = await startConversation()

    const frames = await runTurn(conversationId, '改一下那张图')

    const [end] = eventsOfType(frames, 'toolEnd')
    expect(end).toMatchObject({ toolCallId: 'call-1', status: 'failed' })
    // 模型换个参数就能重试，所以这一条不该把整轮拖垮。
    expect(eventsOfType(frames, 'turnEnd')[0]!.stopReason).toBe('completed')
    expect(await db.select().from(schema.tasks)).toHaveLength(0)
  })
})

describe('智能体读素材库工具', () => {
  it('finds the signed-in user assets by keyword', async () => {
    const cookie = await createUser('user-a')
    await createUser('user-b')
    await giveAsset('user-a', '橘猫产品图', 'img-cat')
    await giveAsset('user-a', '浅木色背景', 'img-wood')
    await giveAsset('user-b', '别人的橘猫', 'img-other')

    const calls: AgentCall[] = []
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () => toolCallCompletion({ id: 'call-1', name: 'readLibrary', args: { query: '橘猫' } }),
        () => completionStream('找到了'),
      ]),
    )
    const conversationId = await startConversation(cookie)

    const frames = await runTurn(conversationId, '我素材库里的橘猫图', { cookie })

    const [end] = eventsOfType(frames, 'toolEnd')
    expect(end).toMatchObject({ toolCallId: 'call-1', status: 'succeeded' })
    // 读素材库不产出画布对象。
    expect(end!.artifacts).toBeUndefined()

    // 查到的图片 id 要回到模型手上，它才能接着拿去改图。
    const seen = JSON.stringify(calls.at(-1)!.messages)
    expect(seen).toContain('img-cat')
    expect(seen).not.toContain('img-wood')
    expect(seen).not.toContain('img-other')
  })

  it('finds nothing for a device that never signed in', async () => {
    await createUser('user-a')
    await giveAsset('user-a', '橘猫产品图', 'img-cat')

    const calls: AgentCall[] = []
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () => toolCallCompletion({ id: 'call-1', name: 'readLibrary', args: {} }),
        () => completionStream('素材库是空的'),
      ]),
    )
    const conversationId = await startConversation()

    const frames = await runTurn(conversationId, '看看我的素材')

    const [end] = eventsOfType(frames, 'toolEnd')
    expect(end!.status).toBe('succeeded')
    expect(JSON.stringify(calls.at(-1)!.messages)).not.toContain('img-cat')
  })

  it('looks a asset up and edits it in the same turn', async () => {
    const cookie = await createUser('user-a')
    await giveAsset('user-a', '橘猫产品图', 'img-cat')

    setAgentFetchForTesting(
      scriptedAgentFetch(
        [],
        [
          () => toolCallCompletion({ id: 'call-1', name: 'readLibrary', args: { query: '橘猫' } }),
          () =>
            toolCallCompletion({
              id: 'call-2',
              name: 'editImage',
              args: { prompt: '换成浅木色背景', imageIds: ['img-cat'] },
            }),
          () => completionStream('改好了'),
        ],
      ),
    )
    const stop = settleSubmittedTasks('completed')
    const conversationId = await startConversation(cookie)

    const frames = await runTurn(conversationId, '把素材库里的橘猫换成浅木色背景', { cookie })
    stop()

    const ends = eventsOfType(frames, 'toolEnd')
    expect(ends.map((event) => event.status)).toEqual(['succeeded', 'succeeded'])
    expect(ends[1]!.anchorObjectId).toBe('img-cat')

    const [task] = await db.select().from(schema.tasks)
    expect(task!.request_payload.input_images).toHaveLength(1)
    expect(task!.user_id).toBe('user-a')
  })
})
