import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { AgentTurnEvent } from '@image-playground/shared'
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
    models: [{ id: modelId, label: modelId, media: 'video', capabilities: ['generate'] }],
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
      body: JSON.stringify({ deviceId: DEVICE, text, references }),
    }),
  )
  return parseFrames(await response.text())
}

function types(frames: { event: AgentTurnEvent }[]): string[] {
  return frames.map((frame) => frame.event.type)
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

    expect(calls[0]!.tools?.map((tool) => tool.function.name).sort()).toEqual([
      'askClarification',
      'editImage',
      'generateImage',
      'generateVideo',
      'readLibrary',
    ])
  })

  it('submits a text-to-video task and reports a video artifact', async () => {
    const calls: AgentCall[] = []
    videoTurn(calls, { prompt: '海浪拍打礁石，镜头缓慢推进' })
    const stop = settleSubmittedTasks()
    const conversationId = await startConversation()

    const frames = await runTurn(conversationId, '来一段海浪的视频')
    stop()

    expect(types(frames)).toEqual([
      'turnStart',
      'toolStart',
      'toolProgress',
      'toolEnd',
      'assistantStart',
      'textDelta',
      'turnEnd',
    ])

    const [end] = eventsOfType(frames, 'toolEnd')
    expect(end).toMatchObject({ toolCallId: 'call-1', toolName: 'generateVideo' })
    expect(end!.status).toBe('succeeded')
    expect(end!.artifacts).toHaveLength(1)
    expect(end!.artifacts![0]).toMatchObject({
      media: 'video',
      mime: 'video/mp4',
      outputIndex: 0,
      durationSeconds: 5,
    })
    // 文生视频没有源图可贴，产出落视口中央。
    expect(end!.anchorImageId).toBeUndefined()

    const turnStart = eventsOfType(frames, 'turnStart')[0]!
    const [task] = await db.select().from(schema.tasks)
    expect(task!.id).toBe(end!.artifacts![0]!.taskId)
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
    expect(end!.status).toBe('succeeded')
    expect(end!.anchorImageId).toBe('canvas-1')

    const [task] = await db.select().from(schema.tasks)
    expect(task!.request_payload.input_images).toHaveLength(1)
    expect(task!.request_payload.video).toMatchObject({ first_frame_index: 0 })
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

  it('falls back to what the resolved model supports', async () => {
    _setChannelsForTesting([TEST_IMAGE_CHANNEL, videoChannel(VEO)])
    const calls: AgentCall[] = []
    // Veo 只有 4 / 6 / 8 秒，也没有 1:1。
    videoTurn(calls, { prompt: '一杯咖啡冒热气', durationSeconds: 10, aspectRatio: '1:1' })
    const stop = settleSubmittedTasks()
    const conversationId = await startConversation()

    await runTurn(conversationId, '来一段方形的咖啡视频')
    stop()

    const [task] = await db.select().from(schema.tasks)
    expect(task!.model).toBe(VEO)
    expect(task!.request_payload.video).toMatchObject({
      duration_seconds: 4,
      aspect_ratio: '16:9',
      resolution: '720p',
    })
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
