import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { type AgentTurnSummaryView, DEVICE_ID_HEADER } from '@image-playground/shared'
import { Elysia } from 'elysia'
import { _setPrivateBffOverlayForTesting } from '../../lib/private-overlay'
import {
  completionStream,
  confirmPendingDrafts,
  eventsOfType,
  parseFrames,
  type ReceivedFrame,
  recordingAgentFetch,
  scriptedAgentFetch,
  TEST_IMAGE_CHANNEL,
  toolCallCompletion,
} from '../helpers/agentStubs'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { installRecordingTaskHooks } from '../helpers/privateOverlayStub'

process.env.DATABASE_URL = await resetTestDatabase('agent_cost_a292')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.UPSTREAM_OPENAI_API_KEY = ''
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
// 生视频也开着：三档明细里的生视频那一档要有真任务才钉得住。
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../agent-video-operator-config.json')

const billing = installRecordingTaskHooks()

const { agentRoutes } = await import('../../routes/agent')
const { setAgentFetchForTesting } = await import('../../lib/agent/model')
const { setQueueTaskPollingForTesting } = await import('../../lib/taskSubmission')
const { _setChannelsForTesting } = await import('../../lib/channels')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { close: closeDb, db, schema } = await import('../../db/client')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
const { purgeOldAgentTurnEvents } = await import('../../lib/agent/events')

type InternalChannel = import('../../lib/channels').InternalChannel

const VIDEO_CHANNEL: InternalChannel = {
  id: 'video-gateway',
  kind: 'openai-queue',
  label: 'Video',
  baseUrl: 'https://gateway.example/v1',
  auth: { type: 'bearer', secretRef: 'VIDEO_API_KEY', secret: 'k' },
  allowedPaths: ['videos/generations'],
  models: [{ id: 'grok-imagine-video', label: 'grok', media: 'video', capabilities: ['generate'] }],
  defaults: { asyncTasks: true },
}

const app = new Elysia().use(agentRoutes)
const DEVICE = 'device-abcdefgh'
const USER_ID = 'agent-cost-user'
const CHAT_MODEL = 'fixture-agent-model'
const IMAGE_MODEL = TEST_IMAGE_CHANNEL.models[0]!.id
const VIDEO_MODEL = VIDEO_CHANNEL.models[0]!.id
let sessionToken = ''

function cookie(): Record<string, string> {
  return { cookie: `${USER_SESSION_COOKIE}=${sessionToken}` }
}

async function post(path: string, body: unknown): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...cookie() },
      body: JSON.stringify(body),
    }),
  )
}

async function startConversation(): Promise<string> {
  const response = await post('/api/agent/conversations', { deviceId: DEVICE })
  const json = (await response.json()) as { conversation: { id: string } }
  return json.conversation.id
}

async function runTurn(
  conversationId: string,
  text: string,
  mode?: 'image' | 'video',
): Promise<ReceivedFrame[]> {
  const response = await post(`/api/agent/conversations/${conversationId}/turns`, {
    deviceId: DEVICE,
    text,
    ...(mode ? { mode } : {}),
  })
  return parseFrames(await response.text())
}

async function readTurnSummaries(conversationId: string): Promise<AgentTurnSummaryView[]> {
  const response = await app.handle(
    new Request(`http://localhost/api/agent/conversations/${conversationId}/messages`, {
      headers: { ...cookie(), [DEVICE_ID_HEADER]: DEVICE },
    }),
  )
  return ((await response.json()) as { turns: AgentTurnSummaryView[] }).turns
}

/** 为生成预扣下的那几笔；对话模型自己那一笔跟着轮走，不算在内。 */
function generationHolds() {
  return billing.reservations.filter((one) => one.model !== CHAT_MODEL)
}

beforeEach(async () => {
  billing.reset()
  _setChannelsForTesting([TEST_IMAGE_CHANNEL, VIDEO_CHANNEL])
  setObjectStoreForTesting(new InMemoryObjectStore())
  setQueueTaskPollingForTesting({ intervalMs: 2, budgetMs: 30_000 })
  await db.delete(schema.tasks)
  await db.delete(schema.agent_conversations)
  await db.delete(schema.user_sessions)
  await db.delete(schema.users)
  const now = Date.now()
  await db.insert(schema.users).values({
    id: USER_ID,
    username: 'agent.cost',
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

describe('本轮消耗', () => {
  it('起轮时报出预扣的积分', async () => {
    setAgentFetchForTesting(recordingAgentFetch([], () => completionStream('好')))
    billing.answer = { kind: 'reserved', credits: 60 }
    const conversationId = await startConversation()

    const frames = await runTurn(conversationId, '把背景换成浅木色')

    expect(eventsOfType(frames, 'turnStart')[0]!.reservedCredits).toBe(60)
  })

  it('轮结束时按结算结果报出本轮消耗', async () => {
    setAgentFetchForTesting(recordingAgentFetch([], () => completionStream('好')))
    billing.settledCredits = 42
    const conversationId = await startConversation()

    const frames = await runTurn(conversationId, '把背景换成浅木色')

    expect(eventsOfType(frames, 'turnEnd')[0]!.cost).toEqual({ chat: 42, image: 0, video: 0 })
  })

  it('拟稿那一轮的页脚只有对话费，生图的钱到用户确认才扣', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(
        [],
        [
          () =>
            toolCallCompletion({
              id: 'call-1',
              name: 'generateImage',
              args: { prompt: '一只橘猫坐在窗台上' },
            }),
        ],
      ),
    )
    billing.settledCredits = 42
    // 任何漏进页脚的生成任务都会按这个单价冒出来，生图那一档的 0 才钉得住。
    billing.creditsPerTask = 85
    const conversationId = await startConversation()

    const frames = await runTurn(conversationId, '画一只橘猫坐在窗台上')

    // 拟稿不建任务也不预扣：这一轮只花了对话的钱。
    expect(generationHolds()).toEqual([])
    expect(eventsOfType(frames, 'turnEnd')[0]!.cost).toEqual({ chat: 42, image: 0, video: 0 })

    const [card] = await confirmPendingDrafts(app, conversationId, {
      deviceId: DEVICE,
      cookie: `${USER_SESSION_COOKIE}=${sessionToken}`,
    })

    // 生图的钱在确认这一刻才扣，且只扣一笔，落在这张卡领到的那条任务上。
    expect(generationHolds()).toEqual([
      {
        taskId: card!.job!.taskId,
        userId: USER_ID,
        model: IMAGE_MODEL,
        quantity: 1,
        unitMultiplier: 1,
      },
    ])
    // 确认出去的任务不归任何一轮的页脚：拟稿那一轮早已结算，不会被回填。
    const turns = await readTurnSummaries(conversationId)
    expect(turns).toHaveLength(1)
    expect(turns[0]!.cost).toEqual({ chat: 42, image: 0, video: 0 })
  })

  it('生视频同理：页脚只有对话费，确认时按草稿冻结的秒数与清晰度预扣', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(
        [],
        [
          () =>
            toolCallCompletion({
              id: 'call-1',
              name: 'generateVideo',
              args: {
                prompt: '海浪拍打礁石',
                durationSeconds: 5,
                resolution: '1080p',
                aspectRatio: '16:9',
              },
            }),
        ],
      ),
    )
    billing.settledCredits = 42
    billing.creditsPerTask = 125
    const conversationId = await startConversation()

    // 生视频工具只在视频轮进模型的清单。
    const frames = await runTurn(conversationId, '来一段海浪的视频', 'video')

    expect(generationHolds()).toEqual([])
    expect(eventsOfType(frames, 'turnEnd')[0]!.cost).toEqual({ chat: 42, image: 0, video: 0 })

    const [card] = await confirmPendingDrafts(app, conversationId, {
      deviceId: DEVICE,
      cookie: `${USER_SESSION_COOKIE}=${sessionToken}`,
    })

    // 视频按秒计价，清晰度是倍率：两样都取拟稿时冻结的那一档。
    expect(generationHolds()).toEqual([
      {
        taskId: card!.job!.taskId,
        userId: USER_ID,
        model: VIDEO_MODEL,
        quantity: 5,
        unitMultiplier: 1.6,
      },
    ])
    const turns = await readTurnSummaries(conversationId)
    expect(turns).toHaveLength(1)
    expect(turns[0]!.cost).toEqual({ chat: 42, image: 0, video: 0 })
  })

  it('失败的轮消耗是零', async () => {
    setAgentFetchForTesting(async () => new Response('rate limited', { status: 429 }))
    billing.settledCredits = 42
    const conversationId = await startConversation()

    const frames = await runTurn(conversationId, '把背景换成浅木色')

    const end = eventsOfType(frames, 'turnEnd')[0]!
    expect(end.stopReason).toBe('failed')
    expect(end.cost).toEqual({ chat: 0, image: 0, video: 0 })
  })

  it('历史里每轮带上耗时与消耗', async () => {
    setAgentFetchForTesting(recordingAgentFetch([], () => completionStream('好')))
    billing.settledCredits = 42
    const conversationId = await startConversation()

    const frames = await runTurn(conversationId, '把背景换成浅木色')
    const turnId = eventsOfType(frames, 'turnStart')[0]!.turnId

    const turns = await readTurnSummaries(conversationId)
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({
      turnId,
      stopReason: 'completed',
      cost: { chat: 42, image: 0, video: 0 },
    })
    expect(turns[0]!.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('轮事件过了保留窗口被清掉，昨天以前的轮翻回去仍有耗时与消耗', async () => {
    setAgentFetchForTesting(recordingAgentFetch([], () => completionStream('好')))
    billing.settledCredits = 42
    const conversationId = await startConversation()

    const frames = await runTurn(conversationId, '把背景换成浅木色')
    const turnId = eventsOfType(frames, 'turnStart')[0]!.turnId
    // 保留窗口给 0：这一轮的事件立刻算过期，等同于隔天再翻回来。
    expect(await purgeOldAgentTurnEvents(0, Date.now() + 1_000)).toBeGreaterThan(0)

    const turns = await readTurnSummaries(conversationId)
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({
      turnId,
      stopReason: 'completed',
      cost: { chat: 42, image: 0, video: 0 },
    })
  })
})
