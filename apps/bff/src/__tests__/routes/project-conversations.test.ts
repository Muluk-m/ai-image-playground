import { afterAll, beforeEach, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'

process.env.PORT = '0'
process.env.DATABASE_URL = await resetTestDatabase('bff_project_conversations')
process.env.OPERATOR_CONFIG_FILE = resolve(
  import.meta.dir,
  '../project-conversations-operator-config.json',
)
const { app } = await import('../../app')
const { close, db, schema } = await import('../../db/client')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
let deviceA: string
let deviceB: string
beforeEach(async () => {
  await db.delete(schema.users)
  const now = Date.now()
  await db.insert(schema.users).values({
    id: 'project-owner',
    username: 'project-owner',
    password_hash: 'fixture',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
  const session = async () =>
    `${USER_SESSION_COOKIE}=${await db.transaction((tx) => createUserSession('project-owner', tx))}`
  deviceA = await session()
  deviceB = await session()
})
afterAll(close)
function request(path: string, cookie: string, method = 'GET', body?: unknown) {
  return app.handle(
    new Request(`http://localhost/api/projects${path}`, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  )
}
async function createProject(cookie: string) {
  const id = crypto.randomUUID()
  const response = await request(`/${id}`, cookie, 'PUT', {
    requestId: crypto.randomUUID(),
    baseRevision: 0,
    name: '会话归属验收',
    document: { version: 1, elements: [] },
  })
  expect(response.status).toBe(200)
  return id
}
it('两设备首次取得同一项目会话时只有一个身份，重新读取项目恢复同一关联且不改画布修订', async () => {
  const id = await createProject(deviceA)
  const responses = await Promise.all([
    request(`/${id}/conversation`, deviceA, 'PUT', {}),
    request(`/${id}/conversation`, deviceB, 'PUT', {}),
  ])
  expect(responses.map((r) => r.status)).toEqual([200, 200])
  const [a, b] = await Promise.all(responses.map((r) => r.json()))
  expect(a.conversation.id).toBe(b.conversation.id)
  expect(a.conversation.id).toBeString()
  expect(await (await request(`/${id}`, deviceB)).json()).toMatchObject({
    id,
    revision: 1,
    conversationId: a.conversation.id,
  })
  const list = await (await request('', deviceB)).json()
  expect(list.projects[0]).toMatchObject({ id, conversationId: a.conversation.id })
  const again = await (await request(`/${id}/conversation`, deviceA, 'PUT', {})).json()
  expect(again.conversation.id).toBe(a.conversation.id)
})
it('已有会话可绑定其所有者的一个项目，重复绑定幂等，另一个项目不能复用该上下文', async () => {
  const created = await app.handle(
    new Request('http://localhost/api/agent/conversations', {
      method: 'POST',
      headers: { cookie: deviceA, 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'device-test-437' }),
    }),
  )
  expect(created.status).toBe(200)
  const { conversation } = await created.json()
  const a = await createProject(deviceA),
    b = await createProject(deviceA)
  const bind = await request(`/${a}/conversation`, deviceA, 'PUT', {
    conversationId: conversation.id,
  })
  expect(bind.status).toBe(200)
  expect((await bind.json()).conversation.id).toBe(conversation.id)
  expect(
    (await request(`/${a}/conversation`, deviceB, 'PUT', { conversationId: conversation.id }))
      .status,
  ).toBe(200)
  expect(
    (await request(`/${b}/conversation`, deviceB, 'PUT', { conversationId: conversation.id }))
      .status,
  ).toBe(409)
  expect(await (await request(`/${b}`, deviceB)).json()).toMatchObject({ conversationId: null })
})
it('拒绝匿名、其他账号和设备会话绑定，不能借请求体伪造项目或会话归属', async () => {
  const id = await createProject(deviceA)
  const now = Date.now()
  await db.insert(schema.users).values({
    id: 'outsider',
    username: 'outsider',
    password_hash: 'fixture',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
  const stranger = `${USER_SESSION_COOKIE}=${await db.transaction((tx) => createUserSession('outsider', tx))}`
  const newConversation = async (cookie: string) => {
    const response = await app.handle(
      new Request('http://localhost/api/agent/conversations', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: 'device-test-437' }),
      }),
    )
    expect(response.status).toBe(200)
    return (await response.json()).conversation.id as string
  }
  const strangerConversation = await newConversation(stranger)
  const anonymousConversation = await newConversation('')
  expect((await request(`/${id}/conversation`, '', 'PUT', {})).status).toBe(401)
  expect((await request(`/${id}/conversation`, stranger, 'PUT', {})).status).toBe(404)
  expect(
    (await request(`/${id}/conversation`, deviceA, 'PUT', { conversationId: strangerConversation }))
      .status,
  ).toBe(404)
  expect(
    (
      await request(`/${id}/conversation`, deviceA, 'PUT', {
        conversationId: anonymousConversation,
      })
    ).status,
  ).toBe(404)
  expect(await (await request(`/${id}`, deviceA)).json()).toMatchObject({ conversationId: null })
})
it('两设备读取绑定会话的消息和历史消耗，重复加载不创建轮或改变结算记录', async () => {
  const id = await createProject(deviceA)
  const { conversation } = await (await request(`/${id}/conversation`, deviceA, 'PUT', {})).json()
  const { appendAgentMessage } = await import('../../lib/agent/conversations')
  const { recordAgentTurnSummary } = await import('../../lib/agent/turn-summary')
  const turnId = crypto.randomUUID()
  await appendAgentMessage(db, {
    conversationId: conversation.id,
    turnId,
    role: 'assistant',
    content: [{ type: 'text', text: '历史回答' }],
  })
  await recordAgentTurnSummary({
    conversationId: conversation.id,
    turnId,
    durationMs: 1200,
    stopReason: 'completed',
    cost: { chat: 2, image: 30, video: 0 },
  })
  const histories = []
  for (const cookie of [deviceA, deviceB, deviceB]) {
    const response = await app.handle(
      new Request(`http://localhost/api/agent/conversations/${conversation.id}/messages`, {
        headers: { cookie, 'x-device-id': 'device-test-437' },
      }),
    )
    expect(response.status).toBe(200)
    histories.push(await response.json())
  }
  expect(histories[0]).toMatchObject({
    messages: [{ content: [{ type: 'text', text: '历史回答' }] }],
    turns: [
      { turnId, durationMs: 1200, stopReason: 'completed', cost: { chat: 2, image: 30, video: 0 } },
    ],
    activeTurn: null,
  })
  expect(histories[1]).toEqual(histories[0])
  expect(histories[2]).toEqual(histories[0])
  const other = await createProject(deviceA)
  const second = await (await request(`/${other}/conversation`, deviceB, 'PUT', {})).json()
  expect(second.conversation.id).not.toBe(conversation.id)
  const separate = await app.handle(
    new Request(`http://localhost/api/agent/conversations/${second.conversation.id}/messages`, {
      headers: { cookie: deviceB, 'x-device-id': 'device-test-437' },
    }),
  )
  expect(await separate.json()).toMatchObject({ messages: [], turns: [], activeTurn: null })
})
