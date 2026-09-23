import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import {
  type AgentBackgroundJobsResponse,
  type AgentMessageView,
  type AgentToolResultBlock,
  type AgentTurnEvent,
  DEVICE_ID_HEADER,
} from '@image-playground/shared'
import { and, eq } from 'drizzle-orm'
import { Elysia } from 'elysia'
import sharp from 'sharp'
import {
  type AgentCall,
  completionStream,
  confirmPendingDrafts,
  controlledCompletion,
  eventsOfType,
  parseFrames,
  recordingAgentFetch,
  scriptedAgentFetch,
  submittedPrompt,
  TEST_IMAGE_CHANNEL,
  TEST_RESULT_PAYLOAD,
  toolCallCompletion,
} from '../helpers/agentStubs'
import { silenceChatUpstream } from '../helpers/chatStubs'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { waitFor } from '../helpers/upstreamStubs'

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
const { imageSelection } = await import('../../lib/agent/selection-preview')
const { finishTask } = await import('../../db/task-transitions')
const { pickUpStrandedInboxes } = await import('../../lib/agent/inbox-pickup')
const { conversationsWithEndedJobs } = await import('../../lib/agent/wake')
const { _setPrivateBffOverlayForTesting, EMPTY_PRIVATE_BFF_OVERLAY } = await import(
  '../../lib/private-overlay'
)

await silenceChatUpstream()
_setPrivateBffOverlayForTesting(EMPTY_PRIVATE_BFF_OVERLAY)

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

/** 用 worker 写终态的那个函数把一条任务跑成功：唤醒判断发生在它的事务里。 */
async function completeWithWorker(taskId: string): Promise<void> {
  await db.update(schema.tasks).set({ status: 'in_progress' }).where(eq(schema.tasks.id, taskId))
  const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId))
  await finishTask(taskId, {
    status: 'completed',
    completedAt: Date.now(),
    resultPayload: {
      data: Array.from(
        { length: task!.request_payload.n ?? 1 },
        () => TEST_RESULT_PAYLOAD.data[0]!,
      ),
    },
  })
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

/** 会话里现在的结果卡。拟稿只落卡不建任务，待确认的那张只能从这里看。 */
async function toolCards(conversationId: string, cookie?: string): Promise<AgentToolResultBlock[]> {
  const response = await app.handle(
    new Request(`http://localhost/api/agent/conversations/${conversationId}/messages`, {
      headers: { [DEVICE_ID_HEADER]: DEVICE, ...(cookie ? { cookie } : {}) },
    }),
  )
  const { messages } = (await response.json()) as { messages: AgentMessageView[] }
  return messages.flatMap((message) =>
    message.content.flatMap((block) => (block.type === 'toolResult' ? [block] : [])),
  )
}

/** 用户在卡上按下「确认生成」：任务、预扣与后台登记都要到这一步才有。 */
function confirmDrafts(conversationId: string, cookie?: string) {
  return confirmPendingDrafts(app, conversationId, {
    deviceId: DEVICE,
    ...(cookie ? { cookie } : {}),
  })
}

/** 正在跑的那一轮的 id：插话与停止都按它寻址，拟稿轮不再建任务，拿不到 `agent_turn_id`。 */
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
  return turnId!
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

/**
 * 局部改图的候选结束后会唤醒智能体再起一轮：等它投递、起轮、收尾都完了。任务是用户确认之后
 * 才建的，提交它的那一轮早收尾了，没人顺手取这条唤醒——线上由巡查接手，这里替它巡。
 */
async function waitForWakeTurns(): Promise<void> {
  await waitFor(async () => {
    await pickUpStrandedInboxes()
    const [running] = await db
      .select({ id: schema.agent_executions.conversation_id })
      .from(schema.agent_executions)
      .where(eq(schema.agent_executions.state, 'running'))
    const [pending] = await db
      .select({ id: schema.agent_inbox.id })
      .from(schema.agent_inbox)
      .where(eq(schema.agent_inbox.status, 'pending'))
    const due = await conversationsWithEndedJobs()
    return !running && !pending && due.length === 0
  }, 5_000)
}

afterEach(async () => {
  // 别让唤醒轮跑进下一条用例清库的时候。
  await waitForWakeTurns()
  setAgentFetchForTesting()
  setQueueTaskPollingForTesting()
  setObjectStoreForTesting()
})

afterAll(async () => {
  await closeDb()
})

describe('智能体改图工具', () => {
  it('keeps each independent target bound to its own selection', async () => {
    const otherMask = `data:image/png;base64,${(
      await sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#000000' } })
        .composite([
          {
            input: await sharp({
              create: { width: 128, height: 128, channels: 4, background: '#ffffff' },
            })
              .png()
              .toBuffer(),
            left: 64,
            top: 64,
            blend: 'dest-out',
          },
        ])
        .png()
        .toBuffer()
    ).toString('base64')}`
    const references = [
      { imageId: 'masked-a', dataUrl: PIXEL, maskDataUrl: MASK },
      { imageId: 'masked-b', dataUrl: PIXEL, maskDataUrl: otherMask },
    ]
    const selections = await Promise.all(references.map((reference) => imageSelection(reference)))
    setAgentFetchForTesting(
      scriptedAgentFetch(
        [],
        [
          () =>
            toolCallCompletion(
              ...references.map((image, index) => ({
                id: `masked-${index}`,
                name: 'editImage',
                args: {
                  imageIds: [image.imageId],
                  prompt: '只把本图选区改成蓝色',
                  selectionBindings: [
                    { imageId: image.imageId, selectionId: selections[index]!.id },
                  ],
                },
              })),
            ),
          () => completionStream('请检查两个候选'),
        ],
      ),
    )
    const conversationId = await startConversation()
    await runTurn(conversationId, '两张图分别只把各自选区改成蓝色，其他不变', {
      references,
    })
    const ends = await confirmDrafts(conversationId)
    expect(ends).toHaveLength(2)
    for (const [index, image] of references.entries()) {
      const end = ends.find((one) => one.toolCallId === `masked-${index}`)!
      expect(end).toMatchObject({ status: 'submitted', anchorObjectId: image.imageId })
      const [task] = await db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.id, end.job!.taskId))
      const request = await hydrateInputImages(task!.request_payload)
      expect(request.mask).toBe(image.maskDataUrl)
      expect(request.prompt).toContain(selections[index]!.id)
      expect(request.prompt).not.toContain(selections[1 - index]!.id)
      await completeWithWorker(task!.id)
    }
    await pickUpStrandedInboxes()
  })

  it('keeps four independently edited photos isolated through submission and partial failure', async () => {
    const references = await Promise.all(
      ['#ff0000', '#00ff00', '#0000ff', '#ffff00'].map(async (background, index) => ({
        imageId: `photo-${index}`,
        dataUrl: `data:image/png;base64,${(
          await sharp({ create: { width: 1024, height: 1024, channels: 4, background } })
            .png()
            .toBuffer()
        ).toString('base64')}`,
      })),
    )
    const prompts = references.map(
      (_, index) => `相机向左环绕 ${20 + index * 10} 度，保留当前照片的主体、场景与光源`,
    )
    setAgentFetchForTesting(
      scriptedAgentFetch(
        [],
        [
          () =>
            toolCallCompletion(
              ...references.map((reference, index) => ({
                id: `edit-${index}`,
                name: 'editImage',
                args: { imageIds: [reference.imageId], prompt: prompts[index] },
              })),
            ),
          () => completionStream('四张照片已分别提交'),
        ],
      ),
    )
    const conversationId = await startConversation()
    await runTurn(conversationId, '四张照片分别向左环绕20、30、40、50度', {
      references,
    })
    const ends = await confirmDrafts(conversationId)
    expect(ends).toHaveLength(4)
    for (const [index, reference] of references.entries()) {
      const end = ends.find((event) => event.toolCallId === `edit-${index}`)!
      expect(end).toMatchObject({
        status: 'submitted',
        anchorObjectId: reference.imageId,
        prompt: prompts[index],
      })
      const [task] = await db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.id, end.job!.taskId))
      const request = await hydrateInputImages(task!.request_payload)
      expect(request.input_images).toEqual([reference.dataUrl])
      expect(request.prompt).toBe(submittedPrompt(prompts[index]!))
      expect(request.n).toBe(1)
      await db
        .update(schema.tasks)
        .set({ status: 'in_progress' })
        .where(eq(schema.tasks.id, task!.id))
      await finishTask(
        task!.id,
        index === 1
          ? {
              status: 'failed',
              completedAt: Date.now(),
              errorType: 'upstream_error',
              errorMessage: 'one image failed',
            }
          : { status: 'completed', resultPayload: TEST_RESULT_PAYLOAD, completedAt: Date.now() },
      )
    }
    const results = await settledResults(conversationId)
    await pickUpStrandedInboxes()
    for (const [index, reference] of references.entries()) {
      expect(results.find((result) => result.anchorObjectId === reference.imageId)?.status).toBe(
        index === 1 ? 'failed' : 'succeeded',
      )
    }
  })

  it('keeps explicit product references attached to one target and n as versions', async () => {
    const second = `data:image/png;base64,${(
      await sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#ff0000' } })
        .png()
        .toBuffer()
    ).toString('base64')}`
    setAgentFetchForTesting(
      scriptedAgentFetch(
        [],
        [
          () =>
            toolCallCompletion({
              id: 'product-edit',
              name: 'editImage',
              args: {
                imageIds: ['target', 'product-reference'],
                prompt: '只替换目标图商品，参考图提供款式，保留目标图背景',
                n: 2,
              },
            }),
          () => completionStream('已提交两个版本'),
        ],
      ),
    )
    const conversationId = await startConversation()
    await runTurn(conversationId, '用第二张的商品替换第一张商品，出两个版本', {
      references: [
        { imageId: 'target', dataUrl: PIXEL },
        { imageId: 'product-reference', dataUrl: second },
      ],
    })
    const ends = await confirmDrafts(conversationId)
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ status: 'submitted', anchorObjectId: 'target' })
    const [task] = await db.select().from(schema.tasks)
    const request = await hydrateInputImages(task!.request_payload)
    expect(request.input_images).toEqual([PIXEL, second])
    expect(request.n).toBe(2)
    await completeWithWorker(task!.id)
    const [result] = await settledResults(conversationId)
    expect(result?.anchorObjectId).toBe('target')
    expect(result?.artifacts).toHaveLength(2)
  })

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
      const [start] = eventsOfType(second, 'toolStart')
      expect(start).toMatchObject({ anchorObjectId: 'canvas-original' })
      // 拟稿这一刻不占画布：稿子还可能被用户改掉，也可能永远不确认。
      expect(start!.outputCount).toBeUndefined()
      // 局部改图同样只拟稿，卡片停在等确认，任务一条都还没有。
      expect(eventsOfType(second, 'toolEnd')[0]).toMatchObject({
        status: 'awaiting_confirmation',
        anchorObjectId: 'canvas-original',
      })
      expect(await db.select().from(schema.tasks)).toHaveLength(0)

      await confirmDrafts(conversationId)

      // 确认之后才提交：张数照拟稿那一刻冻结的两张，候选等任务结束后结算。
      const [settled] = await settledResults(conversationId)
      expect(settled!.artifacts).toHaveLength(2)
      const [task] = await db.select().from(schema.tasks)
      const submitted = await hydrateInputImages(task!.request_payload)
      expect(submitted.input_images).toEqual([PIXEL])
      expect(submitted.mask).toBe(MASK)
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
      // 没有选区的普通改图一样只拟稿：卡片停在等确认，确认后才落成后台任务。
      expect(eventsOfType(frames, 'toolEnd')[0]).toMatchObject({
        status: 'awaiting_confirmation',
        anchorObjectId: 'canvas-original',
      })
      expect(await db.select().from(schema.tasks)).toHaveLength(0)

      const [confirmed] = await confirmDrafts(conversationId)

      // 锚点跟着草稿一起冻结：确认之后产出还是贴着同一张源图落。
      expect(confirmed).toMatchObject({
        status: 'submitted',
        anchorObjectId: 'canvas-original',
      })
      expect(confirmed!.job?.taskId).toBeTruthy()
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
        status: 'awaiting_confirmation',
        anchorObjectId: 'canvas-svg',
      })
      // 只有附了图的那一轮带 image 块；后一轮是纯文字，图靠 id 取。
      for (const call of calls.slice(0, 1)) {
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
      await confirmDrafts(conversationId)
      const [task] = await db.select().from(schema.tasks)
      const submitted = await hydrateInputImages(task!.request_payload)
      expect(submitted.input_images![0]).toStartWith('data:image/png;base64,')
      const stored = await db
        .select()
        .from(schema.agent_messages)
        .where(eq(schema.agent_messages.conversation_id, conversationId))
      expect(stored.flatMap((message) => message.content)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            references: [
              {
                imageId: 'canvas-svg',
                image: { mime: 'image/svg+xml', object: expect.any(String) },
              },
            ],
          }),
        ]),
      )
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
      expect(result).toMatchObject({
        status: 'awaiting_confirmation',
        anchorObjectId: 'original-b',
      })
      const [confirmedReplacement] = await confirmDrafts(conversationId)
      const [replacementTask] = await db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.id, confirmedReplacement!.job!.taskId))
      const request = await hydrateInputImages(replacementTask!.request_payload)
      expect(request.input_images).toEqual([otherPixel])
      expect(request.mask).toBeUndefined()

      const old = await edit(conversationId, 'original-a')
      const oldResult = eventsOfType(old, 'toolEnd')[0]!
      // 新轮仍能取回旧图，但旧选区不能跟着原图变成这次修改的约束。
      expect(oldResult).toMatchObject({
        status: 'awaiting_confirmation',
        anchorObjectId: 'original-a',
      })
      const [confirmedOld] = await confirmDrafts(conversationId)
      const [oldTask] = await db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.id, confirmedOld!.job!.taskId))
      const oldRequest = await hydrateInputImages(oldTask!.request_payload)
      expect(oldRequest.input_images).toEqual([PIXEL])
      expect(oldRequest.mask).toBeUndefined()

      // 等后台任务结束，避免它干扰下面的会话隔离检查。
      await waitFor(
        async () =>
          (await db.select().from(schema.tasks).where(eq(schema.tasks.id, oldTask!.id)))[0]
            ?.status === 'completed',
        3_000,
      )
      await waitForWakeTurns()
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

  it('lets a later turn with no attachment regenerate the whole image after an earlier selection', async () => {
    const conversationId = await startConversation()
    setAgentFetchForTesting(scriptedAgentFetch([], [() => completionStream('看到选区了')]))
    await runTurn(conversationId, '把 [image 1] 圈里的部分改掉', {
      references: [{ imageId: 'canvas-1', dataUrl: PIXEL, maskDataUrl: MASK }],
    })

    setAgentFetchForTesting(
      scriptedAgentFetch(
        [],
        [
          () =>
            toolCallCompletion({
              id: 'call-1',
              name: 'generateImage',
              args: { prompt: '整张界面重做一版' },
            }),
          () => completionStream('已拟稿'),
        ],
      ),
    )
    // 用户这一轮什么都没附：上一轮的选区不该再把整轮锁在局部改图里。
    const frames = await runTurn(conversationId, '别改局部了，整张重做一版')

    expect(eventsOfType(frames, 'toolEnd')[0]).toMatchObject({
      toolName: 'generateImage',
      status: 'awaiting_confirmation',
    })
    expect(frames.at(-1)?.event).toMatchObject({ type: 'turnEnd', stopReason: 'completed' })
  })

  it('lets a later turn redraw an archived masked image without uploading it again', async () => {
    const conversationId = await startConversation()
    setAgentFetchForTesting(scriptedAgentFetch([], [() => completionStream('看到选区了')]))
    await runTurn(conversationId, '把 [image 1] 圈里的部分改掉', {
      references: [{ imageId: 'canvas-1', dataUrl: PIXEL, maskDataUrl: MASK }],
    })
    setAgentFetchForTesting(
      scriptedAgentFetch(
        [],
        [
          () =>
            toolCallCompletion({
              id: 'redraw',
              name: 'editImage',
              args: { prompt: '整张界面重做一版', imageIds: ['image 1'] },
            }),
          () => completionStream('已拟稿'),
        ],
      ),
    )
    const frames = await runTurn(conversationId, '整张重做')
    expect(eventsOfType(frames, 'toolEnd')[0]).toMatchObject({
      toolName: 'editImage',
      status: 'awaiting_confirmation',
      anchorObjectId: 'canvas-1',
    })
    const [confirmed] = await confirmDrafts(conversationId)
    const [task] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, confirmed!.job!.taskId))
    const submitted = await hydrateInputImages(task!.request_payload)
    expect(submitted.input_images).toEqual([PIXEL])
    expect(submitted.mask).toBeUndefined()
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
    // 参考图上没有真选区：这是普通改图，提示词原样进卡，等用户确认。
    const [end] = eventsOfType(frames, 'toolEnd')
    expect(end).toMatchObject({
      toolCallId: 'call-1',
      status: 'awaiting_confirmation',
      prompt: '把背景换成浅木色',
    })
    // 产出贴着源图放，源图本身不进这次任务的产出。
    expect(end!.anchorObjectId).toBe('canvas-1')
    expect(await db.select().from(schema.tasks)).toHaveLength(0)

    await confirmDrafts(conversationId)

    const [settled] = await settledResults(conversationId)
    stop()

    expect(settled).toMatchObject({ status: 'succeeded', anchorObjectId: 'canvas-1' })
    expect(settled!.artifacts).toHaveLength(1)
    expect(settled!.artifacts![0]!.artifactId).not.toBe('canvas-1')

    const [task] = await db.select().from(schema.tasks)
    expect(task!.request_payload.prompt).toBe(submittedPrompt('把背景换成浅木色'))
    expect(task!.request_payload.input_images).toHaveLength(1)
    expect(task!.request_payload.mask).toBeUndefined()

    // `loadSkill` 在场是因为 `apps/bff/skills/image` 里有随仓库发的技能。
    expect(calls[0]!.tools?.map((tool) => tool.function.name).sort()).toEqual([
      'askClarification',
      'editCanvasObject',
      'editImage',
      'generateImage',
      'loadSkill',
      'readCanvas',
      'readLibrary',
      'viewImage',
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

    const frames = await runTurn(conversationId, '把 [image 1] 圈出来的部分改掉', {
      references: [{ imageId: 'canvas-1', dataUrl: PIXEL, maskDataUrl: MASK }],
    })
    stop()

    // 卡上给用户看的是真会送进上游的那一句：遮罩编辑的执行指令由服务端拼，不是模型写的摘要。
    const [pending] = eventsOfType(frames, 'toolEnd')
    expect(pending!.status).toBe('awaiting_confirmation')
    expect(pending!.prompt).toContain('执行局部图像编辑')
    expect(pending!.prompt).toContain('把 [image 1] 圈出来的部分改掉')

    await confirmDrafts(conversationId)

    const [task] = await db.select().from(schema.tasks)
    expect(task!.request_payload.mask).toBeTruthy()
    // 提交出去的还是卡上那一句。
    expect(task!.request_payload.prompt).toBe(submittedPrompt(pending!.prompt!))
  })

  it('hands a local edit back as a background job the agent must review', async () => {
    const calls: AgentCall[] = []
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
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
        () => completionStream('已开始改'),
      ]),
    )
    const conversationId = await startConversation()

    // 没有 worker：改图只拟稿，确认之前连任务都还没有。
    const frames = await runTurn(conversationId, '把 [image 1] 圈出来的部分改掉', {
      references: [{ imageId: 'canvas-1', dataUrl: PIXEL, maskDataUrl: MASK }],
    })

    const [end] = eventsOfType(frames, 'toolEnd')
    expect(end).toMatchObject({ status: 'awaiting_confirmation', anchorObjectId: 'canvas-1' })
    expect(end!.job).toBeUndefined()
    expect(frames.at(-1)?.event).toMatchObject({ type: 'turnEnd', stopReason: 'completed' })
    expect(await db.select().from(schema.tasks)).toHaveLength(0)
    expect(await db.select().from(schema.agent_jobs)).toHaveLength(0)

    await confirmDrafts(conversationId)

    // 确认之后才是后台任务：任务留在队列里，这一轮早已收尾。
    const [task] = await db.select().from(schema.tasks)
    expect(task!.status).toBe('queued')
    // 候选必须复核：模型没要求，拟稿时冻结的登记里也记着成功后唤醒。
    const [job] = await db
      .select()
      .from(schema.agent_jobs)
      .where(eq(schema.agent_jobs.task_id, task!.id))
    expect(job).toMatchObject({ tool_call_id: 'call-1', wake_on_success: true })
    // 拟完稿这一轮就收尾：不再多问模型一次。
    expect(calls).toHaveLength(1)
  })

  it('stopping a later turn leaves the pending draft confirmable', async () => {
    const calls: AgentCall[] = []
    const reply = controlledCompletion()
    const answers = [
      () =>
        toolCallCompletion({
          id: 'call-stop',
          name: 'editImage',
          args: {
            prompt: '只改这一块',
            imageIds: ['canvas-1'],
            selectionBindings: bindings('canvas-1'),
          },
        }),
      (signal?: AbortSignal) => reply.responseFor(signal),
    ]
    let at = 0
    setAgentFetchForTesting(recordingAgentFetch(calls, (signal) => answers[at++]!(signal)))
    const conversationId = await startConversation()
    // 第一轮拟好稿就收尾：卡停在等确认，任务还一条都没有。
    const drafting = await runTurn(conversationId, '把 [image 1] 圈出来的部分改掉', {
      references: [{ imageId: 'canvas-1', dataUrl: PIXEL, maskDataUrl: MASK }],
    })
    expect(eventsOfType(drafting, 'toolEnd')[0]).toMatchObject({
      status: 'awaiting_confirmation',
    })

    // 用户没点确认，先又说了一句，说到一半把这一轮停掉。
    const finished = runTurn(conversationId, '等一下，我再想想')
    await waitFor(() => calls.length === 2, 3_000)
    const turnId = await runningTurnId(conversationId)
    const stopped = await post(`/api/agent/conversations/${conversationId}/turns/${turnId}/abort`, {
      deviceId: DEVICE,
    })
    expect(stopped.status).toBe(200)
    const frames = await finished
    expect(frames.at(-1)?.event).toMatchObject({ type: 'turnEnd', stopReason: 'aborted' })

    // 停止只停这段回复：拟好的稿还在，确认照样按冻结的材料提交，遮罩一并带出去。
    const [pending] = await toolCards(conversationId)
    expect(pending).toMatchObject({ status: 'awaiting_confirmation', toolName: 'editImage' })
    const [confirmed] = await confirmDrafts(conversationId)
    expect(confirmed).toMatchObject({ status: 'submitted' })
    const [task] = await db.select().from(schema.tasks)
    expect(task!.status).toBe('queued')
    expect((await hydrateInputImages(task!.request_payload)).mask).toBe(MASK)
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
    expect(ends.map((event) => event.status)).toEqual(['succeeded', 'awaiting_confirmation'])
    expect(ends[1]!.anchorObjectId).toBe('img-cat')
    expect(await db.select().from(schema.tasks)).toHaveLength(0)

    await confirmDrafts(conversationId, cookie)

    // 素材库里的图确认之后照样进任务，任务仍挂在这个登录用户名下。
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
        // 唤醒轮：候选已经出来了，模型却想照原样再提一次同一件事。
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
  const frames = await runTurn(conversationId, '参考原图只修改圈中头枕的位置', {
    references: [{ imageId: 'target', dataUrl: PIXEL, maskDataUrl: MASK }],
  })

  // 卡上摆的是服务端拼出来的执行指令：带用户原话，不带模型自己写的那句摘要。
  const [drafted] = eventsOfType(frames, 'toolEnd')
  expect(drafted!.status).toBe('awaiting_confirmation')
  expect(drafted!.prompt).toContain('参考原图只修改圈中头枕的位置')
  expect(drafted!.prompt).not.toContain('把头枕降低到椅背上沿')

  await confirmDrafts(conversationId)
  const [task] = await db.select().from(schema.tasks)
  expect(task!.request_payload.prompt).toBe(submittedPrompt(drafted!.prompt!))

  // 候选跑完把模型唤醒来复核，计划跟着草稿冻结、随确认落到登记上，唤醒轮接着它走。
  await completeWithWorker(task!.id)
  expect(await pickUpStrandedInboxes()).toBe(1)
  const refusal = async () =>
    (await toolCards(conversationId)).find((card) => card.status === 'failed')
  await waitFor(async () => (await refusal()) !== undefined, 5_000)
  await waitForWakeTurns()

  // 这一条追加不在冻结的批次里：拒绝的是「别自行追加」，不是「这条内容提过了」。
  expect((await refusal())?.message).toBe(
    '本轮编辑计划已经执行，不能自行追加生成；请检查已有候选并等待用户指示',
  )
  // 没有第二次收费：任务还是那一条，也没有多出一张等着确认的卡。
  expect(await db.select().from(schema.tasks)).toHaveLength(1)
  expect(
    (await toolCards(conversationId)).filter((card) => card.status === 'awaiting_confirmation'),
  ).toEqual([])
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
  const frames = await runTurn(conversationId, '参考原图只修改圈中头枕的位置', {
    references: [{ imageId: 'target', dataUrl: PIXEL, maskDataUrl: MASK }],
  })
  const ends = eventsOfType(frames, 'toolEnd')
  expect(ends.map((event) => event.status)).toEqual(['awaiting_confirmation', 'failed'])
  expect(ends[1]?.message).toBe('这个编辑操作已经拟过稿，请先检查候选；不要自行重复拟稿')
  // 重复的那一次连稿都没拟出来：确认之后也只有一条任务。
  expect(await db.select().from(schema.tasks)).toHaveLength(0)
  await confirmDrafts(conversationId)
  expect(await db.select().from(schema.tasks)).toHaveLength(1)
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
  const frames = await runTurn(conversationId, '选区内做一个红色版本、一个蓝色版本，其他不变', {
    references: [{ imageId: 'target', dataUrl: PIXEL, maskDataUrl: MASK }],
  })
  // 分别提出来的两处改动各拟一份稿，谁也没被当成重复。
  expect(eventsOfType(frames, 'toolEnd').map((event) => event.status)).toEqual([
    'awaiting_confirmation',
    'awaiting_confirmation',
  ])

  await confirmDrafts(conversationId)

  const tasks = await db.select().from(schema.tasks)
  expect(tasks).toHaveLength(2)
  expect(tasks.map((task) => task.request_payload.prompt)).toEqual(
    expect.arrayContaining([
      expect.stringContaining('当前操作对应的原文："一个红色版本"'),
      expect.stringContaining('当前操作对应的原文："一个蓝色版本"'),
    ]),
  )
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
  // 两轮都只拟稿（拟完即收尾，一轮只问模型一次），一起确认之后再看第二条指令里有没有第一条。
  await runTurn(conversationId, '将选区改成红色', {
    references: [{ imageId: 'a', dataUrl: PIXEL, maskDataUrl: MASK }],
  })
  await runTurn(conversationId, '去掉选区背景', {
    references: [{ imageId: 'b', dataUrl: PIXEL, maskDataUrl: MASK }],
  })
  await confirmDrafts(conversationId)
  const tasks = await db.select().from(schema.tasks)
  const current = tasks.find((task) => task.request_payload.prompt.includes('去掉选区背景'))!
  expect(current).toBeDefined()
  expect(current.request_payload.prompt).not.toContain('改成红色')
})

it('executes a predeclared dependent edit in the wake turn once its reference artifact exists', async () => {
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
      // 唤醒轮：第一步的产物已经在对话记录里，照预先列明的那一步接着改。
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
      () => completionStream('A 已改好，B 已开始改'),
    ]),
  )
  const conversationId = await startConversation()
  const frames = await runTurn(conversationId, '先修改 A，再以产物为参考修改 B', {
    references: ['a', 'b'].map((imageId) => ({ imageId, dataUrl: PIXEL, maskDataUrl: MASK })),
  })
  // 预先列明的后续编辑也只能拟稿：这一轮先停在等确认，用户点了才提交第一步。
  expect(eventsOfType(frames, 'toolEnd').map((event) => event.status)).toEqual([
    'awaiting_confirmation',
  ])
  await confirmDrafts(conversationId)
  const [first] = await db.select().from(schema.tasks)

  await completeWithWorker(first!.id)
  expect(await pickUpStrandedInboxes()).toBe(1)
  // 唤醒轮接着冻结的计划走，第二步同样拟稿等确认。
  await waitFor(
    async () =>
      (await toolCards(conversationId)).some((card) => card.status === 'awaiting_confirmation'),
    5_000,
  )
  await waitForWakeTurns()
  await confirmDrafts(conversationId)
  const second = (await db.select().from(schema.tasks)).find((task) => task.id !== first!.id)!
  expect(second.request_payload.prompt).toContain('再以产物为参考修改 B')
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
  const second = await runTurn(conversationId, '用这个', {
    references: [{ imageId: 'b', dataUrl: PIXEL }],
  })
  expect(eventsOfType(second, 'toolEnd')[0]!.status).toBe('awaiting_confirmation')

  await confirmDrafts(conversationId)

  // 澄清之前那句要求还没兑现：提交出去的指令里两句都在。
  const [task] = await db.select().from(schema.tasks)
  expect(task?.request_payload.prompt).toContain('只换扶手，颜色和背景不变')
  expect(task?.request_payload.prompt).toContain('用这个')
})

it('does not unlock paid generation when an interjection replaces the active references', async () => {
  const calls: AgentCall[] = []
  const reply = controlledCompletion()
  setAgentFetchForTesting(recordingAgentFetch(calls, (signal) => reply.responseFor(signal)))
  const conversationId = await startConversation()
  const running = runTurn(conversationId, '修改圈选颜色', {
    references: [{ imageId: 'a', dataUrl: PIXEL, maskDataUrl: MASK }],
  })
  // 这一轮卡在上游流上：插话赶在模型给出改图调用之前到，把本轮引用换成另一张。
  await waitFor(() => calls.length === 1, 3_000)
  const turnId = await runningTurnId(conversationId)
  const interjected = await post(
    `/api/agent/conversations/${conversationId}/turns/${turnId}/interject`,
    {
      deviceId: DEVICE,
      text: '参考的是这张，好了吗？',
      references: [{ imageId: 'b', dataUrl: 'data:image/png;base64,Ynk=' }],
    },
  )
  expect(interjected.status).toBe(200)
  reply.pushToolCall(0, {
    id: 'first',
    name: 'editImage',
    args: { prompt: '改颜色', imageIds: ['a'], selectionBindings: bindings('a') },
  })
  reply.finish()
  const frames = await running

  // 拟完稿这一轮就收尾：插话没能换来第二次生成，上游也只被问过这一次。
  expect(eventsOfType(frames, 'toolEnd').map((event) => event.status)).toEqual([
    'awaiting_confirmation',
  ])
  expect(calls).toHaveLength(1)

  await confirmDrafts(conversationId)

  // 确认按拟稿那一刻冻结的材料提交：只有一条任务，用的还是圈了选区的那张原图。
  const tasks = await db.select().from(schema.tasks)
  expect(tasks).toHaveLength(1)
  const request = await hydrateInputImages(tasks[0]!.request_payload)
  expect(request.input_images).toEqual([PIXEL])
  expect(request.mask).toBe(MASK)
})
