import { afterAll, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { Elysia } from 'elysia'
import { completionStream, scriptedAgentFetch, toolCallCompletion } from '../helpers/agentStubs'
import { silenceChatUpstream } from '../helpers/chatStubs'

const temp = await mkdtemp(join(tmpdir(), 'production-test-'))
await writeFile(
  join(temp, 'operator.json'),
  JSON.stringify({ capabilities: { 'agent:chat': true, 'agent:production': true } }),
)
process.env.DATABASE_URL = await resetTestDatabase('production_document')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.OPERATOR_CONFIG_FILE = join(temp, 'operator.json')
const { productionRoutes } = await import('../../routes/production')
const { db, schema, close } = await import('../../db/client')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
const { createAgentConversation } = await import('../../lib/agent/conversations')
const { config } = await import('../../config')
const { agentRoutes } = await import('../../routes/agent')
const { setAgentFetchForTesting } = await import('../../lib/agent/model')
await silenceChatUpstream()
const app = new Elysia().use(productionRoutes).use(agentRoutes)
async function account(id: string) {
  await db.insert(schema.users).values({
    id,
    username: id,
    password_hash: 'fixture',
    status: 'active',
    created_at: Date.now(),
    updated_at: Date.now(),
  })
  const token = await db.transaction((tx) => createUserSession(id, tx))
  const conversation = await createAgentConversation({ kind: 'user', userId: id }, '雨夜')
  return { cookie: `${USER_SESSION_COOKIE}=${token}`, id: conversation.id }
}
async function request(id: string, cookie: string, body?: unknown) {
  return app.handle(
    new Request(`http://localhost/api/agent/conversations/${id}/production`, {
      method: body ? 'PUT' : 'GET',
      headers: { cookie, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  )
}
it('creates a session-owned script, restores it and rejects foreign access and stale revisions', async () => {
  const a = await account('production-owner')
  const b = await account('production-stranger')
  const content = {
    title: '雨夜',
    setting: '上海，雨夜',
    outline: '一次偶遇',
    scenes: [{ id: 'scene-one', title: '站台', body: '她撑着伞走来。' }],
  }
  const mutation = { operationId: 'create-first-script', baseRevision: 0, content }
  const first = await request(a.id, a.cookie, mutation)
  expect(first.status).toBe(200)
  const saved = await first.json()
  expect(saved.document.content).toEqual(content)
  expect(saved.document.revision).toBe(1)
  expect((await (await request(a.id, a.cookie)).json()).document.id).toBe(saved.document.id)
  expect((await (await request(a.id, a.cookie, mutation)).json()).document.revision).toBe(1)
  expect((await request(a.id, b.cookie)).status).toBe(404)
  expect((await request(a.id, a.cookie, { ...mutation, operationId: 'stale-write' })).status).toBe(
    409,
  )
})
it('denies disabled production reads and writes without changing the saved text', async () => {
  const owner = await account('production-disabled')
  const content = { title: '剧本', setting: '保留', outline: '', scenes: [] }
  await request(owner.id, owner.cookie, { operationId: 'initial', baseRevision: 0, content })
  const original = config.operator
  config.operator = {
    ...original,
    capabilities: { ...original.capabilities, 'agent:production': false },
  }
  try {
    expect((await request(owner.id, owner.cookie)).status).toBe(404)
    expect(
      (
        await request(owner.id, owner.cookie, {
          operationId: 'denied',
          baseRevision: 1,
          content: { ...content, setting: '覆盖' },
        })
      ).status,
    ).toBe(404)
  } finally {
    config.operator = original
  }
  expect((await (await request(owner.id, owner.cookie)).json()).document.content.setting).toBe(
    '保留',
  )
})
it('restores an earlier script as a new revision without losing intervening history', async () => {
  const owner = await account('production-editor')
  const first = { title: '初稿', setting: '雨夜', outline: '相遇', scenes: [] }
  await request(owner.id, owner.cookie, { operationId: 'first', baseRevision: 0, content: first })
  await request(owner.id, owner.cookie, {
    operationId: 'edit',
    baseRevision: 1,
    content: { ...first, title: '二稿' },
  })
  const restore = () =>
    app.handle(
      new Request(`http://localhost/api/agent/conversations/${owner.id}/production/restore`, {
        method: 'POST',
        headers: { cookie: owner.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ operationId: 'restore-first', baseRevision: 2, revision: 1 }),
      }),
    )
  const result = await restore()
  expect(result.status).toBe(200)
  const saved = await result.json()
  expect(saved.document.revision).toBe(3)
  expect(saved.document.content.title).toBe('初稿')
  expect(saved.history.map((r: { revision: number }) => r.revision)).toEqual([1, 2, 3])
  expect(saved.history[2].source).toBe('restore')
  expect((await (await restore()).json()).document.revision).toBe(3)
})
it('executes the real Agent tool through SSE and reads the saved script through HTTP', async () => {
  const owner = await account('production-agent')
  const content = {
    title: '最后一班车',
    setting: '雨夜',
    outline: '陌生人相遇',
    scenes: [{ id: 'platform', title: '站台', body: '列车驶进雨幕。' }],
  }
  const calls: AgentCall[] = []
  setAgentFetchForTesting(
    scriptedAgentFetch(
      calls,
      [
        () => toolCallCompletion({ id: 'script-call', name: 'writeProduction', args: { content } }),
        () => completionStream('剧本已保存，请查看右侧面板。'),
      ],
    ),
  )
  const response = await app.handle(
    new Request(`http://localhost/api/agent/conversations/${owner.id}/turns`, {
      method: 'POST',
      headers: { cookie: owner.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'production-device',
        text: '写一个雨夜站台的短片剧本并保存',
        params: { productionMode: true, autoSubmit: true },
      }),
    }),
  )
  expect(response.status).toBe(200)
  const stream = await response.text()
  expect(stream).toContain('writeProduction')
  expect(JSON.stringify(calls[0]?.messages)).toContain('当前是视频制作对话')
  expect(JSON.stringify(calls[0]?.messages)).not.toContain('拟好提示词就当场提交')
  expect((await (await request(owner.id, owner.cookie)).json()).document.content).toEqual(content)
  setAgentFetchForTesting()
})
afterAll(async () => {
  await close()
  await rm(temp, { recursive: true, force: true })
})
