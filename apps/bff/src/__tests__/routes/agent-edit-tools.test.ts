import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { AgentTurnEvent } from '@image-playground/shared'
import { eq } from 'drizzle-orm'
import { Elysia } from 'elysia'
import sharp from 'sharp'
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
const { hydrateInputImages } = await import('../../lib/imageArchive')
const { selectionPreview } = await import('../../lib/agent/selection-preview')

const app = new Elysia().use(agentRoutes)
const DEVICE = 'device-abcdefgh'

const PIXEL = `data:image/png;base64,${(
  await sharp({ create: { width: 2, height: 2, channels: 4, background: '#ffffff' } })
    .png()
    .toBuffer()
).toString('base64')}`
const MASK = `data:image/png;base64,${(
  await sharp({ create: { width: 2, height: 2, channels: 4, background: '#00000000' } })
    .png()
    .toBuffer()
).toString('base64')}`

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
  readonly params?: { thinkingDepth: 'fast' | 'medium' | 'deep' }
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
        params: options.params,
        ...(options.references ? { references: options.references } : {}),
      }),
    }),
  )
  const body = await response.text()
  if (!response.ok) throw new Error(`turn returned ${response.status}: ${body}`)
  return parseFrames(body)
}

/** 测试里的迷你 worker：把工具刚提交的任务推到终态，让工具循环能往下跑。 */
function settleSubmittedTasks(outcome: 'completed' | 'failed'): () => void {
  let stopped = false
  void (async () => {
    while (!stopped) {
      const queued = await db.select().from(schema.tasks).where(eq(schema.tasks.status, 'queued'))
      for (const task of queued) {
        await db
          .update(schema.tasks)
          .set(
            outcome === 'completed'
              ? {
                  status: 'completed',
                  result_payload: {
                    data: Array.from(
                      { length: task.request_payload.n ?? 1 },
                      () => TEST_RESULT_PAYLOAD.data[0]!,
                    ),
                  },
                  completed_at: Date.now(),
                }
              : {
                  status: 'failed',
                  error_message: '上游拒绝了这张图',
                  error_type: 'upstream_error',
                },
          )
          .where(eq(schema.tasks.id, task.id))
      }
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
  it('edits the original image after clarification without attaching it again', async () => {
    const calls: AgentCall[] = []
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () =>
          toolCallCompletion({
            id: 'clarify',
            name: 'askClarification',
            args: {
              question: '想设计哪类新交互？',
              options: ['悬浮卡片与展开详情', '完整的页面交互流程'],
            },
          }),
        () =>
          toolCallCompletion({
            id: 'edit-after-answer',
            name: 'editImage',
            args: { prompt: '基于原图设计悬浮卡片与展开详情', imageIds: ['canvas-original'], n: 2 },
          }),
        () => completionStream('已生成新的设计图'),
      ]),
    )
    const conversationId = await startConversation()
    const first = await runTurn(conversationId, '[image 1] 基于它设计一个新的交互', {
      references: [{ imageId: 'canvas-original', dataUrl: PIXEL, maskDataUrl: MASK }],
    })
    expect(eventsOfType(first, 'clarification')).toHaveLength(1)
    const stop = settleSubmittedTasks('completed')
    try {
      const second = await runTurn(conversationId, '悬浮卡片与展开详情，给我两个版本')
      expect(eventsOfType(second, 'toolStart')[0]).toMatchObject({
        outputCount: 2,
        anchorObjectId: 'canvas-original',
      })
      expect(eventsOfType(second, 'toolEnd')[0]).toMatchObject({
        status: 'succeeded',
        anchorObjectId: 'canvas-original',
      })
      expect(eventsOfType(second, 'toolEnd')[0]?.artifacts).toHaveLength(2)
      const [task] = await db.select().from(schema.tasks)
      const submitted = await hydrateInputImages(task!.request_payload)
      expect(submitted.input_images).toEqual([PIXEL])
      expect(submitted.mask).toBe(MASK)
      expect(calls[1]!.messages.at(-1)!.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'image_url',
            image_url: expect.objectContaining({
              url: `data:image/png;base64,${(await selectionPreview({ dataUrl: PIXEL, maskDataUrl: MASK })).data}`,
            }),
          }),
        ]),
      )
    } finally {
      stop()
    }
  })

  it('lets the model see the reference and resolves its displayed image number', async () => {
    const calls: AgentCall[] = []
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () =>
          toolCallCompletion({
            id: 'edit-by-number',
            name: 'editImage',
            args: { prompt: '保留原图主体设计新界面', imageIds: ['image 1'] },
          }),
        () => completionStream('已生成'),
      ]),
    )
    const conversationId = await startConversation()
    const stop = settleSubmittedTasks('completed')
    try {
      const frames = await runTurn(conversationId, '[image 1] 设计新界面', {
        references: [{ imageId: 'canvas-original', dataUrl: PIXEL }],
      })
      expect(calls[0]!.messages.at(-1)!.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'image_url',
            image_url: expect.objectContaining({ url: PIXEL }),
          }),
        ]),
      )
      expect(eventsOfType(frames, 'toolEnd')[0]).toMatchObject({
        status: 'succeeded',
        anchorObjectId: 'canvas-original',
      })
    } finally {
      stop()
    }
  })

  it('rasterizes SVG references for both the model and tools when continuing a stored conversation', async () => {
    const svg = `data:image/svg+xml;base64,${Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16"><rect width="24" height="16" fill="red"/></svg>',
    ).toString('base64')}`
    const calls: AgentCall[] = []
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () => completionStream('已看到参考图'),
        () =>
          toolCallCompletion({
            id: 'edit-svg',
            name: 'editImage',
            args: { prompt: '修改背景', imageIds: ['image 1'] },
          }),
        () => completionStream('已完成'),
      ]),
    )
    const conversationId = await startConversation()
    const first = await runTurn(conversationId, '参考这张图', {
      references: [{ imageId: 'canvas-svg', dataUrl: svg }],
    })
    expect(eventsOfType(first, 'turnEnd')[0]).toMatchObject({ stopReason: 'completed' })
    const stop = settleSubmittedTasks('completed')
    try {
      const continued = await runTurn(conversationId, '继续修改')
      expect(eventsOfType(continued, 'toolEnd')[0]).toMatchObject({
        status: 'succeeded',
        anchorObjectId: 'canvas-svg',
      })
      for (const call of calls.slice(0, 2)) {
        const content = call.messages.at(-1)!.content as {
          type: string
          image_url?: { url: string }
        }[]
        const image = content.find((block) => block.type === 'image_url')!.image_url!.url
        expect(image).toStartWith('data:image/png;base64,')
        expect(await sharp(Buffer.from(image.split(',')[1]!, 'base64')).metadata()).toMatchObject({
          format: 'png',
          width: 24,
          height: 16,
        })
      }
      const [task] = await db.select().from(schema.tasks)
      const submitted = await hydrateInputImages(task!.request_payload)
      expect(submitted.input_images![0]).toStartWith('data:image/png;base64,')
      const [stored] = await db
        .select()
        .from(schema.agent_messages)
        .where(eq(schema.agent_messages.conversation_id, conversationId))
      expect(stored!.content[0]).toMatchObject({
        references: [{ imageId: 'canvas-svg', image: { mime: 'image/svg+xml' } }],
      })
    } finally {
      stop()
    }
  })

  it('rebinds image numbers to new attachments without losing old ids or leaking across conversations', async () => {
    const conversationId = await startConversation()
    const otherPixel = 'data:image/png;base64,Ynk='
    setAgentFetchForTesting(scriptedAgentFetch([], [() => completionStream('已看到参考图')]))
    await runTurn(conversationId, '[image 1] 原图', {
      references: [{ imageId: 'original-a', dataUrl: PIXEL, maskDataUrl: MASK }],
    })
    const edit = async (target: string, id: string, references?: TurnOptions['references']) => {
      setAgentFetchForTesting(
        scriptedAgentFetch(
          [],
          [
            () =>
              toolCallCompletion({
                id: crypto.randomUUID(),
                name: 'editImage',
                args: { prompt: '保留主体改背景', imageIds: [id] },
              }),
            () => completionStream('完成'),
          ],
        ),
      )
      return runTurn(target, '修改这张', { references })
    }
    const stop = settleSubmittedTasks('completed')
    try {
      const replacement = await edit(conversationId, '[image 1]', [
        { imageId: 'original-b', dataUrl: otherPixel },
      ])
      const result = eventsOfType(replacement, 'toolEnd')[0]!
      expect(result).toMatchObject({ status: 'succeeded', anchorObjectId: 'original-b' })
      const [replacementTask] = await db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.id, result.artifacts![0]!.taskId))
      const request = await hydrateInputImages(replacementTask!.request_payload)
      expect(request.input_images).toEqual([otherPixel])
      expect(request.mask).toBeUndefined()

      const old = await edit(conversationId, 'original-a')
      const oldResult = eventsOfType(old, 'toolEnd')[0]!
      expect(oldResult).toMatchObject({ status: 'succeeded', anchorObjectId: 'original-a' })
      const [oldTask] = await db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.id, oldResult.artifacts![0]!.taskId))
      expect((await hydrateInputImages(oldTask!.request_payload)).mask).toBe(MASK)

      const otherConversation = await startConversation()
      const inaccessible = await edit(otherConversation, 'original-a')
      expect(eventsOfType(inaccessible, 'toolEnd')[0]!.status).toBe('failed')
      expect(
        await db
          .select()
          .from(schema.tasks)
          .where(eq(schema.tasks.agent_conversation_id, otherConversation)),
      ).toEqual([])
    } finally {
      stop()
    }
  })

  it('names the anchor on toolStart so the canvas reserves next to the source image', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(
        [],
        [
          () =>
            toolCallCompletion({
              id: 'call-1',
              // 模型常常报编号而不是 id；占位要用的是翻译回来的画布对象 id。
              name: 'editImage',
              args: { prompt: '把背景换成浅木色', imageIds: ['image 1'] },
            }),
          () => completionStream('改好了'),
        ],
      ),
    )
    const stop = settleSubmittedTasks('completed')
    const conversationId = await startConversation()

    const frames = await runTurn(conversationId, '把 [image 1] 的背景换成浅木色', {
      references: [{ imageId: 'canvas-1', dataUrl: PIXEL }],
    })
    stop()

    const [start] = eventsOfType(frames, 'toolStart')
    expect(start).toMatchObject({ toolName: 'editImage', anchorObjectId: 'canvas-1' })
    // 起跑时说的锚点和跑完时说的必须是同一个，否则产物会换个地方落。
    expect(eventsOfType(frames, 'toolEnd')[0]!.anchorObjectId).toBe('canvas-1')
  })

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

for (const [depth, model, effort] of [
  ['fast', 'gpt-5.6-luna', 'low'],
  ['medium', 'gpt-5.6-sol', 'medium'],
  ['deep', 'gpt-6-astra', 'high'],
] as const) {
  it(`sends the ${depth} model and reasoning effort to the gateway`, async () => {
    const calls: AgentCall[] = []
    setAgentFetchForTesting(scriptedAgentFetch(calls, [() => completionStream('你好')]))
    const id = await startConversation()
    await runTurn(id, '你好', { params: { thinkingDepth: depth } })
    expect(calls[0]?.model).toBe(model)
    expect(calls[0]?.reasoning_effort).toBe(effort)
  })
}
