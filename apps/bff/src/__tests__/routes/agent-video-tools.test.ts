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
import { _setPrivateBffOverlayForTesting } from '../../lib/private-overlay'
import {
  type AgentCall,
  completionStream,
  eventsOfType,
  parseFrames,
  scriptedAgentFetch,
  TEST_IMAGE_CHANNEL,
  toolCallCompletion,
} from '../helpers/agentStubs'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { installRecordingTaskHooks } from '../helpers/privateOverlayStub'

process.env.DATABASE_URL = await resetTestDatabase('agent_video_a291')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.UPSTREAM_OPENAI_API_KEY = ''
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../agent-video-operator-config.json')

const billing = installRecordingTaskHooks()

// Dynamic imports keep environment setup ahead of modules that capture configuration.
const { agentRoutes } = await import('../../routes/agent')
const { setAgentFetchForTesting } = await import('../../lib/agent/model')
const { setQueueTaskPollingForTesting } = await import('../../lib/taskSubmission')
const { _setChannelsForTesting } = await import('../../lib/channels')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
const { close: closeDb, db, schema } = await import('../../db/client')

type InternalChannel = import('../../lib/channels').InternalChannel

const app = new Elysia().use(agentRoutes)
const DEVICE = 'device-abcdefgh'
const USER_ID = 'agent-video-user'
const PIXEL = 'data:image/png;base64,aGk='

const GROK = 'grok-imagine-video'
const VEO = 'veo-3.1-lite-generate-preview'
const AGNES = 'agnes-video-2.5-flash'

const VIDEO_RESULT_PAYLOAD = {
  data: [{ url: 'https://cdn.test/clip.mp4', mime: 'video/mp4', duration_seconds: 5 }],
}

function videoChannel(modelId: string): InternalChannel {
  return {
    id: 'video-gateway',
    kind: 'openai-queue',
    label: 'Video',
    baseUrl: 'https://gateway.example/v1',
    auth: { type: 'bearer', secretRef: 'VIDEO_API_KEY', secret: 'k' },
    allowedPaths: ['videos/generations'],
    models: [
      {
        id: modelId,
        label: modelId,
        media: 'video',
        capabilities: ['generate', 'reference_images'],
      },
    ],
    defaults: { asyncTasks: true },
  }
}

let sessionToken = ''
let storage: InMemoryObjectStore

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
  return { status: response.status, json: await response.json() }
}

async function startConversation(): Promise<string> {
  const { status, json } = await post('/api/agent/conversations', { deviceId: DEVICE })
  expect(status).toBe(200)
  return (json as { conversation: { id: string } }).conversation.id
}

async function runTurn(conversationId: string, text: string, references: unknown[] = []) {
  const response = await app.handle(
    new Request(`http://localhost/api/agent/conversations/${conversationId}/turns`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `${USER_SESSION_COOKIE}=${sessionToken}`,
      },
      // 生视频工具只在视频轮进模型的清单，所以这一整份用例都按视频轮起。
      body: JSON.stringify({ deviceId: DEVICE, text, references, mode: 'video' }),
    }),
  )
  return parseFrames(await response.text())
}

/** 等迷你 worker 把任务推到终态，读回结算过的后台任务。 */
async function settledJobs(conversationId: string): Promise<AgentToolResultBlock[]> {
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
      headers: {
        [DEVICE_ID_HEADER]: DEVICE,
        cookie: `${USER_SESSION_COOKIE}=${sessionToken}`,
      },
    }),
  )
  return ((await response.json()) as AgentBackgroundJobsResponse).jobs.map((job) => job.result)
}

function types(frames: { event: AgentTurnEvent }[]): string[] {
  return frames.map((frame) => frame.event.type)
}

/** 工具收尾之后模型收到的那一份对话，工具结果就在里面。 */
function modelReport(calls: AgentCall[]): string {
  return JSON.stringify(calls.at(-1)!.messages)
}

/** 测试里的迷你 worker：把工具刚提交的任务推到终态，让工具循环能往下跑。 */
function settleSubmittedTasks(): () => void {
  let stopped = false
  void (async () => {
    while (!stopped) {
      await db
        .update(schema.tasks)
        .set({
          status: 'completed',
          result_payload: VIDEO_RESULT_PAYLOAD,
          completed_at: Date.now(),
        })
        .where(eq(schema.tasks.status, 'queued'))
      await Bun.sleep(2)
    }
  })()
  return () => {
    stopped = true
  }
}

/** 上游先要一次生视频，再回一句话收尾。 */
function videoTurn(calls: AgentCall[], args: Record<string, unknown>) {
  setAgentFetchForTesting(
    scriptedAgentFetch(calls, [
      () => toolCallCompletion({ id: 'call-1', name: 'generateVideo', args }),
      () => completionStream('视频好了'),
    ]),
  )
}

beforeEach(async () => {
  billing.reset()
  storage = new InMemoryObjectStore()
  setObjectStoreForTesting(storage)
  _setChannelsForTesting([TEST_IMAGE_CHANNEL, videoChannel(GROK)])
  setQueueTaskPollingForTesting({ intervalMs: 2, budgetMs: 30_000 })
  await db.delete(schema.tasks)
  await db.delete(schema.agent_conversations)
  await db.delete(schema.user_sessions)
  await db.delete(schema.users)
  const now = Date.now()
  await db.insert(schema.users).values({
    id: USER_ID,
    username: 'agent.video',
    password_hash: 'hash',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
  sessionToken = await db.transaction((tx) => createUserSession(USER_ID, tx))
})

afterEach(() => {
  setAgentFetchForTesting()
  setQueueTaskPollingForTesting()
  setObjectStoreForTesting()
})

afterAll(async () => {
  _setPrivateBffOverlayForTesting()
  await closeDb()
})

describe('智能体生视频工具', () => {
  it('offers the tool where generation:video is on', async () => {
    const calls: AgentCall[] = []
    setAgentFetchForTesting(scriptedAgentFetch(calls, [() => completionStream('好')]))
    const conversationId = await startConversation()

    await runTurn(conversationId, '你好')

    // 视频轮照样带着生图与改图：首帧要先画出来、改到位，再让它动起来。
    // `loadSkill` 在场是因为 `apps/bff/skills/video` 里有随仓库发的技能。
    expect(calls[0]!.tools?.map((tool) => tool.function.name).sort()).toEqual([
      'askClarification',
      'editImage',
      'generateImage',
      'generateVideo',
      'loadSkill',
      'readLibrary',
    ])
  })

  it('submits a text-to-video task and reports a video artifact', async () => {
    const calls: AgentCall[] = []
    videoTurn(calls, { prompt: '海浪拍打礁石，镜头缓慢推进' })
    const stop = settleSubmittedTasks()
    const conversationId = await startConversation()

    const frames = await runTurn(conversationId, '来一段海浪的视频')

    // 生视频是后台任务：提交即收尾，片子之后按任务结算。
    expect(types(frames)).toEqual([
      'turnStart',
      'toolStart',
      'toolEnd',
      'assistantStart',
      'textDelta',
      'turnEnd',
    ])

    const [end] = eventsOfType(frames, 'toolEnd')
    expect(end).toMatchObject({ toolCallId: 'call-1', toolName: 'generateVideo' })
    expect(end!.status).toBe('submitted')
    const record = { model: GROK, duration: 5, resolution: '720p', aspectRatio: '16:9' }
    expect(end!.job).toMatchObject({ media: 'video', video: record })
    // 文生视频没有源图可贴，产出落视口中央。
    expect(end!.anchorObjectId).toBeUndefined()

    const [settled] = await settledJobs(conversationId)
    stop()
    expect(settled!.status).toBe('succeeded')
    expect(settled!.artifacts).toHaveLength(1)
    // 实际提交的档位随任务记下，结算时落到产物上。
    expect(settled!.artifacts![0]).toMatchObject({
      media: 'video',
      mime: 'video/mp4',
      outputIndex: 0,
      video: record,
    })

    const turnStart = eventsOfType(frames, 'turnStart')[0]!
    const [task] = await db.select().from(schema.tasks)
    expect(task!.id).toBe(end!.job!.taskId)
    expect(task!.model).toBe(GROK)
    expect(task!.agent_turn_id).toBe(turnStart.turnId)
    expect(task!.request_payload.prompt).toBe('海浪拍打礁石，镜头缓慢推进')
    expect(task!.request_payload.input_images).toBeUndefined()
    // 用户没说档位，取现有默认值。
    expect(task!.request_payload.video).toMatchObject({
      duration_seconds: 5,
      resolution: '720p',
      aspect_ratio: '16:9',
    })
  })

  it('animates the referenced image and anchors the output to it', async () => {
    const calls: AgentCall[] = []
    videoTurn(calls, { prompt: '让这只猫眨眼', imageId: 'canvas-1' })
    const stop = settleSubmittedTasks()
    const conversationId = await startConversation()

    const frames = await runTurn(conversationId, '让[image 1]动起来', [
      { imageId: 'canvas-1', dataUrl: PIXEL },
    ])
    stop()

    const [end] = eventsOfType(frames, 'toolEnd')
    expect(end!.status).toBe('submitted')
    expect(end!.anchorObjectId).toBe('canvas-1')
    expect(end!.job!.video).toMatchObject({ firstFrameId: 'canvas-1' })

    const [task] = await db.select().from(schema.tasks)
    expect(task!.request_payload.input_images).toHaveLength(1)
    expect(task!.request_payload.video).toMatchObject({ first_frame_index: 0 })
  })

  it('sends several referenced images as reference images and records them on the video', async () => {
    const calls: AgentCall[] = []
    videoTurn(calls, {
      prompt: '图片1 的人拿着图片2 的球拍挥拍',
      referenceImageIds: ['canvas-1', 'canvas-2', 'canvas-1'],
    })
    const stop = settleSubmittedTasks()
    const conversationId = await startConversation()

    const frames = await runTurn(conversationId, '用[image 1][image 2]做一段挥拍', [
      { imageId: 'canvas-1', dataUrl: PIXEL },
      { imageId: 'canvas-2', dataUrl: PIXEL },
    ])
    stop()

    const [end] = eventsOfType(frames, 'toolEnd')
    expect(end!.status).toBe('submitted')
    expect(end!.anchorObjectId).toBe('canvas-1')
    expect(end!.job!.video).toMatchObject({ referenceIds: ['canvas-1', 'canvas-2'] })
    expect(end!.job!.video).not.toHaveProperty('firstFrameId')

    const [task] = await db.select().from(schema.tasks)
    expect(task!.request_payload.input_images).toHaveLength(2)
    expect(task!.request_payload.video).toMatchObject({ reference_image_indices: [0, 1] })
    expect(task!.request_payload.video).not.toHaveProperty('first_frame_index')
  })

  it('puts the first frame before the references and drops a reference repeating it', async () => {
    const calls: AgentCall[] = []
    videoTurn(calls, {
      prompt: '从这张开始，带上那两样东西',
      imageId: 'canvas-1',
      referenceImageIds: ['canvas-1', 'canvas-2'],
    })
    const stop = settleSubmittedTasks()
    const conversationId = await startConversation()

    const frames = await runTurn(conversationId, '让[image 1]动起来，带上[image 2]', [
      { imageId: 'canvas-1', dataUrl: PIXEL },
      { imageId: 'canvas-2', dataUrl: PIXEL },
    ])
    stop()

    const [end] = eventsOfType(frames, 'toolEnd')
    expect(end!.job!.video).toMatchObject({ firstFrameId: 'canvas-1', referenceIds: ['canvas-2'] })
    const [task] = await db.select().from(schema.tasks)
    expect(task!.request_payload.video).toMatchObject({
      first_frame_index: 0,
      reference_image_indices: [1],
    })
  })

  it('does not submit references the model cannot take, and says why with a code', async () => {
    _setChannelsForTesting([TEST_IMAGE_CHANNEL, videoChannel(AGNES)])
    const calls: AgentCall[] = []
    videoTurn(calls, { prompt: '挥拍', referenceImageIds: ['canvas-1'] })
    const conversationId = await startConversation()

    await runTurn(conversationId, '用[image 1]做视频', [{ imageId: 'canvas-1', dataUrl: PIXEL }])

    // 这一轮只留下对话本身的任务，没有视频任务。
    const tasks = await db.select().from(schema.tasks)
    expect(tasks.filter((task) => task.request_payload.video)).toHaveLength(0)
    expect(modelReport(calls)).toContain('referenceUnsupported')
  })

  it('treats a channel that has not declared reference_images as unable to take them', async () => {
    const channel = videoChannel(GROK)
    _setChannelsForTesting([
      TEST_IMAGE_CHANNEL,
      {
        ...channel,
        models: channel.models.map((model) => ({ ...model, capabilities: ['generate'] })),
      },
    ])
    const calls: AgentCall[] = []
    videoTurn(calls, { prompt: '挥拍', referenceImageIds: ['canvas-1'] })
    const conversationId = await startConversation()

    await runTurn(conversationId, '用[image 1]做视频', [{ imageId: 'canvas-1', dataUrl: PIXEL }])

    const tasks = await db.select().from(schema.tasks)
    expect(tasks.filter((task) => task.request_payload.video)).toHaveLength(0)
    expect(modelReport(calls)).toContain('referenceUnsupported')
  })

  it('describes the reference limit of the current model in the tool parameters', async () => {
    const calls: AgentCall[] = []
    setAgentFetchForTesting(scriptedAgentFetch(calls, [() => completionStream('好')]))
    const conversationId = await startConversation()

    await runTurn(conversationId, '你好')

    const tools = JSON.stringify(calls[0]!.tools)
    expect(tools).toContain('referenceImageIds')
    expect(tools).toContain('最多 7 张')
    expect(tools).toContain('720p')
  })

  it('takes the duration, resolution and aspect ratio the model inferred', async () => {
    const calls: AgentCall[] = []
    videoTurn(calls, {
      prompt: '竖屏城市夜景',
      durationSeconds: 10,
      resolution: '1080p',
      aspectRatio: '9:16',
    })
    const stop = settleSubmittedTasks()
    const conversationId = await startConversation()

    await runTurn(conversationId, '来一段 10 秒竖屏的城市夜景，要 1080p')
    stop()

    const [task] = await db.select().from(schema.tasks)
    expect(task!.request_payload.video).toMatchObject({
      duration_seconds: 10,
      resolution: '1080p',
      aspect_ratio: '9:16',
    })
  })

  it('falls back for what the model never asked, and says which preset it used', async () => {
    _setChannelsForTesting([TEST_IMAGE_CHANNEL, videoChannel(VEO)])
    const calls: AgentCall[] = []
    // 模型一个档位都没填：默认 5 秒 Veo 做不到，按它的矩阵退到 4 秒。没有用户约束被丢掉。
    videoTurn(calls, { prompt: '一杯咖啡冒热气' })
    const stop = settleSubmittedTasks()
    const conversationId = await startConversation()

    const frames = await runTurn(conversationId, '来一段咖啡视频')
    stop()

    const [task] = await db.select().from(schema.tasks)
    expect(task!.model).toBe(VEO)
    expect(task!.request_payload.video).toMatchObject({
      duration_seconds: 4,
      aspect_ratio: '16:9',
      resolution: '720p',
    })
    expect(eventsOfType(frames, 'toolEnd')[0]!.status).toBe('submitted')
    // 退档也要说出口：模型照着这句话才讲得出「我替你定了 4 秒」。
    const report = modelReport(calls)
    expect(report).toContain('4 秒')
    expect(report).toContain('720p')
    expect(report).toContain('16:9')
  })

  it.each([
    // Veo 只有 4 / 6 / 8 秒：10 秒是用户明说的，退到 4 秒等于花钱交付他没要的东西。
    [VEO, { durationSeconds: 10 }, ['durationSeconds', '4 / 6 / 8 秒', 'Veo 3.1 Lite']],
    // Agnes 只有 720p。
    [AGNES, { resolution: '1080p' }, ['resolution', '720p', 'Agnes 2.5 Flash']],
    // Veo 没有 1:1。
    [VEO, { aspectRatio: '1:1' }, ['aspectRatio', '16:9 / 9:16']],
    // 1080p 这一档只配 8 秒；这条走的是 durationsByResolution。
    [VEO, { durationSeconds: 6, resolution: '1080p' }, ['durationSeconds', '1080p 下 8 秒']],
  ] as const)('refuses to submit %s when the model asked for %o, and tells it what is possible', async (modelId, asked, expected) => {
    _setChannelsForTesting([TEST_IMAGE_CHANNEL, videoChannel(modelId)])
    const calls: AgentCall[] = []
    videoTurn(calls, { prompt: '一杯咖啡冒热气', ...asked })
    const stop = settleSubmittedTasks()
    const conversationId = await startConversation()

    const frames = await runTurn(conversationId, '来一段咖啡视频')
    stop()

    // 视频任务一条都没落库、一分都没预扣：没提交就没花钱，这正是「宁可不花钱先说」。
    // （对话轮自己那条任务与预扣照常，所以按模型筛。）
    const tasks = await db.select().from(schema.tasks)
    expect(tasks.filter((task) => task.model === modelId)).toHaveLength(0)
    expect(billing.reservations.filter((one) => one.model === modelId)).toHaveLength(0)
    const [end] = eventsOfType(frames, 'toolEnd')
    // 不算失败：`onError: 'abort'` 会把整轮停掉，模型就没机会把实话讲给用户。
    expect(end!.status).toBe('succeeded')
    expect(end!.artifacts ?? []).toHaveLength(0)
    // 不会有产物的调用不占画布的位，否则那个框永远填不上。
    expect(eventsOfType(frames, 'toolStart')[0]!.outputCount).toBeUndefined()
    // 模型照旧收到最后一句话，回复里才讲得出「这个模型做不到，你要哪个」。
    expect(types(frames).at(-1)).toBe('turnEnd')

    const report = modelReport(calls)
    for (const fragment of expected) expect(report).toContain(fragment)
  })

  it('charges the video task by seconds and the resolution multiplier', async () => {
    const calls: AgentCall[] = []
    videoTurn(calls, { prompt: '海浪', durationSeconds: 10, resolution: '1080p' })
    const stop = settleSubmittedTasks()
    const conversationId = await startConversation()

    await runTurn(conversationId, '来一段 10 秒 1080p 的海浪')
    stop()

    // 对话轮与视频任务各预扣一次，各按各的口径。
    expect(billing.reservations).toHaveLength(2)
    const video = billing.reservations.find((one) => one.model === GROK)
    expect(video).toMatchObject({ userId: USER_ID, quantity: 10, unitMultiplier: 1.6 })
  })
})
