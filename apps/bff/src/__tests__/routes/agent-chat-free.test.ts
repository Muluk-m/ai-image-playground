import { afterAll, beforeEach, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { Elysia } from 'elysia'
import { _setPrivateBffOverlayForTesting } from '../../lib/private-overlay'
import { completionStream, parseFrames, recordingAgentFetch } from '../helpers/agentStubs'
import { silenceChatUpstream } from '../helpers/chatStubs'
import { installRecordingTaskHooks } from '../helpers/privateOverlayStub'

process.env.DATABASE_URL = await resetTestDatabase('agent_chat_free_7c31')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.UPSTREAM_OPENAI_API_KEY = ''
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.OPERATOR_CONFIG_FILE = resolve(
  import.meta.dir,
  '../agent-chat-free-operator-config.json',
)

const billing = installRecordingTaskHooks()
const { reservations, settlements } = billing

const { agentRoutes } = await import('../../routes/agent')
const { setAgentFetchForTesting } = await import('../../lib/agent/model')
const { close: closeDb, db, schema } = await import('../../db/client')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')

await silenceChatUpstream()

const app = new Elysia().use(agentRoutes)
const DEVICE = 'device-abcdefgh'
const USER_ID = 'agent-chat-free-user'
let sessionToken = ''

async function post(path: string, body: unknown): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `${USER_SESSION_COOKIE}=${sessionToken}`,
      },
      body: JSON.stringify(body),
    }),
  )
}

beforeEach(async () => {
  billing.reset()
  await db.delete(schema.tasks)
  await db.delete(schema.agent_conversations)
  await db.delete(schema.user_sessions)
  await db.delete(schema.users)
  const now = Date.now()
  await db.insert(schema.users).values({
    id: USER_ID,
    username: 'agent.chat.free',
    password_hash: 'hash',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
  sessionToken = await db.transaction((tx) => createUserSession(USER_ID, tx))
})

afterAll(async () => {
  setAgentFetchForTesting()
  _setPrivateBffOverlayForTesting()
  await closeDb()
})

it('billing:chat-free 开着时对话轮不预扣不结算，页脚写的是真零', async () => {
  setAgentFetchForTesting(recordingAgentFetch([], () => completionStream('好')))
  const created = await post('/api/agent/conversations', { deviceId: DEVICE })
  const { conversation } = (await created.json()) as { conversation: { id: string } }

  const response = await post(`/api/agent/conversations/${conversation.id}/turns`, {
    deviceId: DEVICE,
    text: '把背景换成浅木色',
  })
  const frames = parseFrames(await response.text())

  // 一分钱都不该碰：既没有预扣，也没有结算。
  expect(reservations).toEqual([])
  expect(settlements).toEqual([])
  // 没有预扣就没有对话任务行——这条路和免费部署那条是同一条。
  expect(await db.select().from(schema.tasks)).toEqual([])
  // 账仍然收拢一次，页脚才写得出「本轮免费」而不是什么都不写。
  expect(frames.at(-1)?.event).toMatchObject({
    type: 'turnEnd',
    cost: { chat: 0, image: 0, video: 0 },
  })
})
