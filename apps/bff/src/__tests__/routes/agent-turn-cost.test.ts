import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { AgentTurnSummaryView } from '@image-playground/shared'
import { eq } from 'drizzle-orm'
import { Elysia } from 'elysia'
import { _setPrivateBffOverlayForTesting } from '../../lib/private-overlay'
import {
  completionStream,
  eventsOfType,
  parseFrames,
  type ReceivedFrame,
  recordingAgentFetch,
  scriptedAgentFetch,
  TEST_IMAGE_CHANNEL,
  TEST_RESULT_PAYLOAD,
  toolCallCompletion,
} from '../helpers/agentStubs'
import { installRecordingTaskHooks } from '../helpers/privateOverlayStub'

process.env.DATABASE_URL = await resetTestDatabase('agent_cost_a292')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.UPSTREAM_OPENAI_API_KEY = ''
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../agent-billing-operator-config.json')

const billing = installRecordingTaskHooks()

const { agentRoutes } = await import('../../routes/agent')
const { setAgentFetchForTesting } = await import('../../lib/agent/model')
const { setQueueTaskPollingForTesting } = await import('../../lib/taskSubmission')
const { _setChannelsForTesting } = await import('../../lib/channels')
const { close: closeDb, db, schema } = await import('../../db/client')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')

const app = new Elysia().use(agentRoutes)
const DEVICE = 'device-abcdefgh'
const USER_ID = 'agent-cost-user'
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

async function runTurn(conversationId: string, text: string): Promise<ReceivedFrame[]> {
  const response = await post(`/api/agent/conversations/${conversationId}/turns`, {
    deviceId: DEVICE,
    text,
  })
  return parseFrames(await response.text())
}

async function readTurnSummaries(conversationId: string): Promise<AgentTurnSummaryView[]> {
  const response = await app.handle(
    new Request(
      `http://localhost/api/agent/conversations/${conversationId}/messages?deviceId=${DEVICE}`,
      { headers: cookie() },
    ),
  )
  return ((await response.json()) as { turns: AgentTurnSummaryView[] }).turns
}

/** 测试里的迷你 worker：把工具刚提交的任务推到完成，让工具循环能往下跑。 */
function settleSubmittedTasks(): () => void {
  let stopped = false
  void (async () => {
    while (!stopped) {
      await db
        .update(schema.tasks)
        .set({ status: 'completed', result_payload: TEST_RESULT_PAYLOAD, completed_at: Date.now() })
        .where(eq(schema.tasks.status, 'queued'))
      await Bun.sleep(2)
    }
  })()
  return () => {
    stopped = true
  }
}

beforeEach(async () => {
  billing.reset()
  _setChannelsForTesting([TEST_IMAGE_CHANNEL])
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

  it('把本轮工具任务的积分归集到生图那一档', async () => {
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
          () => completionStream('画好了'),
        ],
      ),
    )
    billing.settledCredits = 42
    billing.creditsPerTask = 85
    const stop = settleSubmittedTasks()
    const conversationId = await startConversation()

    const frames = await runTurn(conversationId, '画一只橘猫坐在窗台上')
    stop()

    expect(eventsOfType(frames, 'turnEnd')[0]!.cost).toEqual({ chat: 42, image: 85, video: 0 })
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
})
