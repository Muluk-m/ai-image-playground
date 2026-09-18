import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import {
  type AgentBackgroundJobsResponse,
  type AgentToolResultBlock,
  type AgentTurnEvent,
  DEVICE_ID_HEADER,
} from '@image-playground/shared'
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
const { selectionPreview, imageSelection } = await import('../../lib/agent/selection-preview')

const app = new Elysia().use(agentRoutes)
const DEVICE = 'device-abcdefgh'

const PIXEL = `data:image/png;base64,${(
  await sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#ffffff' } })
    .png()
    .toBuffer()
).toString('base64')}`
const MASK = `data:image/png;base64,${(
  await sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#00000000' } })
    .png()
    .toBuffer()
).toString('base64')}`

const SELECTION_ID = (await imageSelection({ dataUrl: PIXEL, maskDataUrl: MASK }))!.id
const bindings = (imageId: string) => [{ imageId, selectionId: SELECTION_ID }]

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

/** 等迷你 worker 把任务推到终态，读回结算过的结果卡。 */
async function settledResults(conversationId: string): Promise<AgentToolResultBlock[]> {
  for (let i = 0; i < 400; i++) {
    const queued = await db
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(eq(schema.tasks.status, 'queued'))
    if (queued.length === 0) break
    await Bun.sleep(5)
  }
  const response = await app.handle(
    new Request(`http://localhost/api/agent/conversations/${conversationId}/jobs`, {
      headers: { [DEVICE_ID_HEADER]: DEVICE },
    }),
  )
  return ((await response.json()) as AgentBackgroundJobsResponse).jobs.map((job) => job.result)
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
            args: {
              prompt: '基于原图设计悬浮卡片与展开详情',
              imageIds: ['canvas-original'],
              selectionBindings: bindings('canvas-original'),
              n: 2,
            },
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
      // 没有选区的普通改图是后台任务：提交即收尾，产物之后按任务结算。
      expect(eventsOfType(frames, 'toolEnd')[0]).toMatchObject({
        status: 'submitted',
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
        status: 'submitted',
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
                args: {
                  prompt: '保留主体改背景',
                  imageIds: [id],
                  ...(id === 'original-a' ? { selectionBindings: bindings(id) } : {}),
                },
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
      expect(result).toMatchObject({ status: 'submitted', anchorObjectId: 'original-b' })
      const [replacementTask] = await db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.id, result.job!.taskId))
      const request = await hydrateInputImages(replacementTask!.request_payload)
      expect(request.input_images).toEqual([otherPixel])
      expect(request.mask).toBeUndefined()

      const old = await edit(conversationId, 'original-a')
      const oldResult = eventsOfType(old, 'toolEnd')[0]!
      // 旧图带着选区：局部改图仍在这一轮里等结果。
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
            args: {
              prompt: '把背景换成浅木色',
              imageIds: ['canvas-1'],
              selectionBindings: bindings('canvas-1'),
            },
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

    // 参考图上没有真选区：这是普通改图，提交即收尾。
    const [end] = eventsOfType(frames, 'toolEnd')
    expect(end).toMatchObject({ toolCallId: 'call-1', status: 'submitted' })
    // 产出贴着源图放，源图本身不进这次任务的产出。
    expect(end!.anchorObjectId).toBe('canvas-1')
    const [settled] = await settledResults(conversationId)
    expect(settled).toMatchObject({ status: 'succeeded', anchorObjectId: 'canvas-1' })
    expect(settled!.artifacts).toHaveLength(1)
    expect(settled!.artifacts![0]!.artifactId).not.toBe('canvas-1')

    const [task] = await db.select().from(schema.tasks)
    expect(task!.request_payload.prompt).toBe('把背景换成浅木色')
    expect(task!.request_payload.input_images).toHaveLength(1)
    expect(task!.request_payload.mask).toBeUndefined()

    // `loadSkill` 在场是因为 `apps/bff/skills/image` 里有随仓库发的技能。
    expect(calls[0]!.tools?.map((tool) => tool.function.name).sort()).toEqual([
      'askClarification',
      'editImage',
      'generateImage',
      'loadSkill',
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
              args: {
                prompt: '只改这一块',
                imageIds: ['canvas-1'],
                selectionBindings: bindings('canvas-1'),
              },
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

  it('keeps a local edit in the turn and withdraws it when the wait runs out', async () => {
    setQueueTaskPollingForTesting({ intervalMs: 2, budgetMs: 20 })
    setAgentFetchForTesting(
      scriptedAgentFetch(
        [],
        [
          () =>
            toolCallCompletion({
              id: 'call-1',
              name: 'editImage',
              args: {
                prompt: '只改这一块',
                imageIds: ['canvas-1'],
                selectionBindings: bindings('canvas-1'),
              },
            }),
          () => completionStream('这次没改成'),
        ],
      ),
    )
    const conversationId = await startConversation()

    // 没有 worker：局部改图仍在这一轮里等结果，等不到就撤掉任务，按可重试的超时收场。
    const frames = await runTurn(conversationId, '把 [image 1] 圈出来的部分改掉', {
      references: [{ imageId: 'canvas-1', dataUrl: PIXEL, maskDataUrl: MASK }],
    })

    expect(eventsOfType(frames, 'toolEnd')[0]).toMatchObject({
      status: 'failed',
      errorCode: 'timeout',
    })
    const [task] = await db.select().from(schema.tasks)
    // 撤掉了，不会在没人等的时候出图计费。
    expect(task!.status).toBe('cancelled')
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
    expect(ends.map((event) => event.status)).toEqual(['succeeded', 'submitted'])
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

it('rejects an empty selection before storing a message or submitting a task', async () => {
  const conversationId = await startConversation()
  const response = await post(`/api/agent/conversations/${conversationId}/turns`, {
    deviceId: DEVICE,
    text: '只改这里',
    references: [{ imageId: 'canvas-empty-mask', dataUrl: PIXEL, maskDataUrl: PIXEL }],
  })
  expect(response).toEqual({ status: 422, json: { error: 'invalid_selection' } })
  expect(await db.select().from(schema.tasks)).toHaveLength(0)
  expect(await db.select().from(schema.agent_messages)).toHaveLength(0)
})

it('does not charge a second masked generation when the model tries again', async () => {
  const args = {
    prompt: '把头枕降低到椅背上沿',
    imageIds: ['target'],
    selectionBindings: bindings('target'),
  }
  setAgentFetchForTesting(
    scriptedAgentFetch(
      [],
      [
        () => toolCallCompletion({ id: 'first-edit', name: 'editImage', args }),
        () =>
          toolCallCompletion({
            id: 'unsolicited-retry',
            name: 'editImage',
            args: { ...args, requestQuote: '圈中头枕的位置' },
          }),
        () => completionStream('请先检查候选图'),
      ],
    ),
  )
  const conversationId = await startConversation()
  const stop = settleSubmittedTasks('completed')
  try {
    const frames = await runTurn(conversationId, '参考原图只修改圈中头枕的位置', {
      references: [{ imageId: 'target', dataUrl: PIXEL, maskDataUrl: MASK }],
    })
    const tasks = await db.select().from(schema.tasks)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.request_payload.prompt).toContain('参考原图只修改圈中头枕的位置')
    expect(tasks[0]!.request_payload.prompt).not.toContain('把头枕降低到椅背上沿')
    const ends = eventsOfType(frames, 'toolEnd')
    expect(ends.map((event) => event.status)).toEqual(['succeeded', 'failed'])
    // 这一条追加不在冻结的批次里：拒绝的是「别自行追加」，不是「这条内容提过了」。
    expect(ends[1]?.message).toBe(
      '本轮编辑计划已经执行，不能自行追加生成；请检查已有候选并等待用户指示',
    )
  } finally {
    stop()
  }
})

/** 与上一条互为对照：同一批次里、内容一模一样的第二次调用，拒绝语与上面那句不是一句。 */
it('refuses an identical masked edit that the approved batch already submitted', async () => {
  const args = {
    prompt: '把头枕降低到椅背上沿',
    imageIds: ['target'],
    selectionBindings: bindings('target'),
    requestQuote: '只修改圈中头枕的位置',
  }
  setAgentFetchForTesting(
    scriptedAgentFetch(
      [],
      [
        () =>
          toolCallCompletion(
            { id: 'first-edit', name: 'editImage', args },
            { id: 'same-edit-again', name: 'editImage', args },
          ),
        () => completionStream('请先检查候选图'),
      ],
    ),
  )
  const conversationId = await startConversation()
  const stop = settleSubmittedTasks('completed')
  try {
    const frames = await runTurn(conversationId, '参考原图只修改圈中头枕的位置', {
      references: [{ imageId: 'target', dataUrl: PIXEL, maskDataUrl: MASK }],
    })
    expect(await db.select().from(schema.tasks)).toHaveLength(1)
    const ends = eventsOfType(frames, 'toolEnd')
    expect(ends.map((event) => event.status)).toEqual(['succeeded', 'failed'])
    expect(ends[1]?.message).toBe('这个编辑操作已经提交，请先检查候选；不要自行付费重试')
  } finally {
    stop()
  }
})

it('does not let the planner omit the selected target and freely edit another image', async () => {
  setAgentFetchForTesting(
    scriptedAgentFetch(
      [],
      [
        () =>
          toolCallCompletion({
            id: 'wrong-target',
            name: 'editImage',
            args: { prompt: '改参考图', imageIds: ['reference'] },
          }),
        () => completionStream('需要核对目标'),
      ],
    ),
  )
  const conversationId = await startConversation()
  const frames = await runTurn(conversationId, '修改图1，参考图2', {
    references: [
      { imageId: 'target', dataUrl: PIXEL, maskDataUrl: MASK },
      { imageId: 'reference', dataUrl: PIXEL },
    ],
  })
  expect(await db.select().from(schema.tasks)).toHaveLength(0)
  expect(eventsOfType(frames, 'toolEnd')[0]?.status).toBe('failed')
})

it('allows separately requested variants while preserving each operation scope', async () => {
  const args = { prompt: '改颜色', imageIds: ['target'], selectionBindings: bindings('target') }
  setAgentFetchForTesting(
    scriptedAgentFetch(
      [],
      [
        () =>
          toolCallCompletion(
            {
              id: 'red',
              name: 'editImage',
              args: { ...args, requestQuote: '一个红色版本' },
            },
            {
              id: 'blue',
              name: 'editImage',
              args: { ...args, requestQuote: '一个蓝色版本' },
            },
          ),
        () => completionStream('已生成两个候选版本'),
      ],
    ),
  )
  const conversationId = await startConversation()
  const stop = settleSubmittedTasks('completed')
  try {
    const frames = await runTurn(conversationId, '选区内做一个红色版本、一个蓝色版本，其他不变', {
      references: [{ imageId: 'target', dataUrl: PIXEL, maskDataUrl: MASK }],
    })
    const tasks = await db.select().from(schema.tasks)
    expect(tasks).toHaveLength(2)
    expect(eventsOfType(frames, 'toolEnd').map((event) => event.status)).toEqual([
      'succeeded',
      'succeeded',
    ])
    expect(tasks.map((task) => task.request_payload.prompt)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('当前操作对应的原文："一个红色版本"'),
        expect.stringContaining('当前操作对应的原文："一个蓝色版本"'),
      ]),
    )
  } finally {
    stop()
  }
})

it('does not carry completed edit instructions into a new masked task', async () => {
  setAgentFetchForTesting(
    scriptedAgentFetch(
      [],
      [
        () =>
          toolCallCompletion({
            id: 'old',
            name: 'editImage',
            args: { prompt: '旧任务', imageIds: ['a'], selectionBindings: bindings('a') },
          }),
        () => completionStream('已生成候选'),
        () =>
          toolCallCompletion({
            id: 'new',
            name: 'editImage',
            args: { prompt: '新任务', imageIds: ['b'], selectionBindings: bindings('b') },
          }),
        () => completionStream('已生成候选'),
      ],
    ),
  )
  const conversationId = await startConversation()
  const stop = settleSubmittedTasks('completed')
  try {
    await runTurn(conversationId, '将选区改成红色', {
      references: [{ imageId: 'a', dataUrl: PIXEL, maskDataUrl: MASK }],
    })
    await runTurn(conversationId, '去掉选区背景', {
      references: [{ imageId: 'b', dataUrl: PIXEL, maskDataUrl: MASK }],
    })
    const tasks = await db.select().from(schema.tasks)
    const current = tasks.find((task) => task.request_payload.prompt.includes('去掉选区背景'))!
    expect(current).toBeDefined()
    expect(current.request_payload.prompt).not.toContain('改成红色')
  } finally {
    stop()
  }
})

it('executes a predeclared dependent edit after its reference artifact exists', async () => {
  const next = {
    targetImageId: 'b',
    selectionId: bindings('b')[0]!.selectionId,
    requestQuote: '再以产物为参考修改 B',
    n: 1,
  }
  const calls: AgentCall[] = []
  setAgentFetchForTesting(
    scriptedAgentFetch(calls, [
      () =>
        toolCallCompletion({
          id: 'first',
          name: 'editImage',
          args: {
            prompt: '第一步',
            imageIds: ['a'],
            selectionBindings: bindings('a'),
            requestQuote: '先修改 A',
            deferredEdits: [next],
          },
        }),
      () => {
        const match = JSON.stringify(calls.at(-1)!.messages).match(/agent_[0-9a-f-]{36}_\d+/)
        if (!match) throw new Error('missing generated reference')
        return toolCallCompletion({
          id: 'dependent',
          name: 'editImage',
          args: {
            prompt: '第二步',
            imageIds: ['b', match[0]],
            selectionBindings: bindings('b'),
            requestQuote: next.requestQuote,
          },
        })
      },
      () => completionStream('已生成两个候选'),
    ]),
  )
  const conversationId = await startConversation()
  const stop = settleSubmittedTasks('completed')
  try {
    const frames = await runTurn(conversationId, '先修改 A，再以产物为参考修改 B', {
      references: ['a', 'b'].map((imageId) => ({ imageId, dataUrl: PIXEL, maskDataUrl: MASK })),
    })
    expect(await db.select().from(schema.tasks)).toHaveLength(2)
    expect(eventsOfType(frames, 'toolEnd').map((event) => event.status)).toEqual([
      'succeeded',
      'succeeded',
    ])
  } finally {
    stop()
  }
})

it('keeps the pending request when clarification asks for a new reference image', async () => {
  setAgentFetchForTesting(
    scriptedAgentFetch(
      [],
      [
        () =>
          toolCallCompletion({
            id: 'ask',
            name: 'askClarification',
            args: { question: '请提供参考图片', options: ['补充参考图', '取消修改'] },
          }),
        () =>
          toolCallCompletion({
            id: 'edit',
            name: 'editImage',
            args: { prompt: '按参考修改', imageIds: ['a', 'b'], selectionBindings: bindings('a') },
          }),
        () => completionStream('已生成候选'),
      ],
    ),
  )
  const conversationId = await startConversation()
  const first = await runTurn(conversationId, '只换扶手，颜色和背景不变', {
    references: [{ imageId: 'a', dataUrl: PIXEL, maskDataUrl: MASK }],
  })
  expect(eventsOfType(first, 'clarification')).toHaveLength(1)
  const stop = settleSubmittedTasks('completed')
  try {
    await runTurn(conversationId, '用这个', { references: [{ imageId: 'b', dataUrl: PIXEL }] })
    const [task] = await db.select().from(schema.tasks)
    expect(task?.request_payload.prompt).toContain('只换扶手，颜色和背景不变')
    expect(task?.request_payload.prompt).toContain('用这个')
  } finally {
    stop()
  }
})

it('does not unlock paid generation when an interjection replaces the active references', async () => {
  setAgentFetchForTesting(
    scriptedAgentFetch(
      [],
      [
        () =>
          toolCallCompletion({
            id: 'first',
            name: 'editImage',
            args: { prompt: '改颜色', imageIds: ['a'], selectionBindings: bindings('a') },
          }),
        () =>
          toolCallCompletion({ id: 'retry', name: 'generateImage', args: { prompt: '追加一张' } }),
        () => completionStream('等待用户下一步'),
      ],
    ),
  )
  const conversationId = await startConversation()
  const running = runTurn(conversationId, '修改圈选颜色', {
    references: [{ imageId: 'a', dataUrl: PIXEL, maskDataUrl: MASK }],
  })
  let task: typeof schema.tasks.$inferSelect | undefined
  for (let i = 0; i < 200 && !task; i++) {
    task = (await db.select().from(schema.tasks))[0]
    if (!task) await Bun.sleep(5)
  }
  expect(task).toBeDefined()
  const interjected = await post(
    `/api/agent/conversations/${conversationId}/turns/${task!.agent_turn_id}/interject`,
    {
      deviceId: DEVICE,
      text: '参考的是这张，好了吗？',
      references: [{ imageId: 'b', dataUrl: PIXEL }],
    },
  )
  expect(interjected.status).toBe(200)
  const stop = settleSubmittedTasks('completed')
  try {
    const frames = await running
    expect(await db.select().from(schema.tasks)).toHaveLength(1)
    expect(eventsOfType(frames, 'toolEnd').map((event) => event.status)).toEqual([
      'succeeded',
      'failed',
    ])
  } finally {
    stop()
  }
})
