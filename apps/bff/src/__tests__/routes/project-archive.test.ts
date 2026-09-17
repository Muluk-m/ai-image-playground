import { afterAll, afterEach, beforeEach, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { sql } from 'drizzle-orm'
import sharp from 'sharp'
import {
  _setPrivateBffOverlayForTesting,
  EMPTY_PRIVATE_BFF_OVERLAY,
} from '../../lib/private-overlay'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'

_setPrivateBffOverlayForTesting(EMPTY_PRIVATE_BFF_OVERLAY)
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'fixture'
process.env.DATABASE_URL = await resetTestDatabase('project_archive')
process.env.OPERATOR_CONFIG_FILE = resolve(
  import.meta.dir,
  '../project-conversations-operator-config.json',
)
const { app } = await import('../../app')
const { db, schema, close } = await import('../../db/client')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
const { createQueueTask } = await import('../../lib/taskSubmission')
const { runTask } = await import('../../workers/task-runner')
const { setUpstreamFetchForTesting } = await import('../../lib/upstream')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { setDurableMediaStoreForTesting } = await import('../../lib/durableMediaStore')
class DurableFixture extends InMemoryObjectStore {
  sign(key: string) {
    return `https://durable.example/${key}`
  }
}
let cookie: string
beforeEach(async () => {
  setObjectStoreForTesting(new InMemoryObjectStore())
  setDurableMediaStoreForTesting(new DurableFixture())
  await db.delete(schema.tasks)
  await db.delete(schema.users)
  await db.insert(schema.users).values({
    id: 'archive-owner',
    username: 'archive-owner',
    password_hash: 'fixture',
    status: 'active',
    created_at: 1,
    updated_at: 1,
  })
  cookie = `${USER_SESSION_COOKIE}=${await db.transaction((tx) => createUserSession('archive-owner', tx))}`
})
afterEach(() => {
  setUpstreamFetchForTesting()
  setObjectStoreForTesting()
  setDurableMediaStoreForTesting()
})
afterAll(close)
function request(path: string, body?: unknown, method = body ? 'PUT' : 'GET') {
  return app.handle(
    new Request(`http://localhost/api/projects${path}`, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  )
}
async function project() {
  const id = crypto.randomUUID()
  expect(
    (
      await request(`/${id}`, {
        requestId: crypto.randomUUID(),
        baseRevision: 0,
        name: '服务端交付',
        document: { version: 1, elements: [] },
      })
    ).status,
  ).toBe(200)
  const { conversation } = await (await request(`/${id}/conversation`, {})).json()
  return { id, conversationId: conversation.id as string }
}
it('接受智能体图片任务时持久预留原项目的产物身份，无浏览器事件也能读取', async () => {
  const original = await project()
  const turnId = crypto.randomUUID()
  const submitted = await createQueueTask({
    provider: 'openai-compat',
    model: 'gpt-image-2',
    request: { prompt: '产品图', device_id: 'archive-device', n: 2 },
    userId: 'archive-owner',
    agent: { conversationId: original.conversationId, turnId },
  })
  expect(submitted.kind).toBe('created')
  if (submitted.kind !== 'created') throw new Error(submitted.kind)
  const restored = await (await request(`/${original.id}`)).json()
  expect(restored.revision).toBe(2)
  expect(restored.document.elements).toMatchObject([
    { type: 'generation', generationId: submitted.taskId, position: 0 },
    { type: 'generation', generationId: submitted.taskId, position: 1 },
  ])
  expect(
    new Set(restored.document.elements.map((element: { id: string }) => element.id)).size,
  ).toBe(2)
})

it('无浏览器连接也向原项目交付，保留用户移动和其他编辑，重放不重复生成或放置', async () => {
  const original = await project()
  const submitted = await createQueueTask({
    provider: 'openai-compat',
    model: 'gpt-image-2',
    request: { prompt: '产品图', device_id: 'archive-device' },
    userId: 'archive-owner',
    agent: { conversationId: original.conversationId, turnId: crypto.randomUUID() },
  })
  if (submitted.kind !== 'created') throw new Error(submitted.kind)
  const reserved = await (await request(`/${original.id}`)).json()
  const element = reserved.document.elements[0]
  const edited = {
    version: 1,
    elements: [
      { ...element, x: 900, y: 240, width: 420, height: 280 },
      {
        id: 'note',
        type: 'text',
        text: '用户保留文字',
        x: 0,
        y: 0,
        width: 150,
        height: 40,
        fontSize: 20,
        fill: '#ffffff',
      },
    ],
  }
  expect(
    (
      await request(`/${original.id}`, {
        requestId: crypto.randomUUID(),
        baseRevision: reserved.revision,
        name: reserved.name,
        document: edited,
      })
    ).status,
  ).toBe(200)
  const unrelated = await project()
  const bytes = await sharp({
    create: { width: 32, height: 24, channels: 4, background: '#ccee99' },
  })
    .png()
    .toBuffer()
  let calls = 0
  setUpstreamFetchForTesting(async () => {
    calls++
    return Response.json({ data: [{ b64_json: bytes.toString('base64') }] })
  })
  await runTask(submitted.taskId)
  const restored = await (await request(`/${original.id}`)).json()
  expect(restored.revision).toBe(4)
  expect(restored.document.elements).toMatchObject([
    { id: element.id, type: 'image', x: 900, y: 240, width: 420, height: 280 },
    { id: 'note', text: '用户保留文字' },
  ])
  expect(restored.document.elements[0].mediaId).toBeString()
  expect((await (await request(`/${unrelated.id}`)).json()).document.elements).toEqual([])
  await runTask(submitted.taskId)
  expect((await (await request(`/${original.id}`)).json()).document).toEqual(restored.document)
  expect(calls).toBe(1)
  expect(
    (
      await request(`/${original.id}`, {
        requestId: crypto.randomUUID(),
        baseRevision: 3,
        name: reserved.name,
        document: edited,
      })
    ).status,
  ).toBe(409)
})
it('不能把其他项目的生成占位复制为本项目的可交付目标', async () => {
  const original = await project(),
    other = await project()
  const submitted = await createQueueTask({
    provider: 'openai-compat',
    model: 'gpt-image-2',
    request: { prompt: '产品图', device_id: 'archive-device' },
    userId: 'archive-owner',
    agent: { conversationId: original.conversationId, turnId: crypto.randomUUID() },
  })
  expect(submitted.kind).toBe('created')
  const reserved = await (await request(`/${original.id}`)).json()
  const response = await request(`/${other.id}`, {
    requestId: crypto.randomUUID(),
    baseRevision: 1,
    name: '另一项目',
    document: reserved.document,
  })
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ error: 'project_output_not_owned' })
  expect((await (await request(`/${other.id}`)).json()).document.elements).toEqual([])
})

it('删除的预留对象不复活，成功原件仍保存在创作记录', async () => {
  const original = await project()
  const submitted = await createQueueTask({
    provider: 'openai-compat',
    model: 'gpt-image-2',
    request: { prompt: '产品图', device_id: 'archive-device' },
    userId: 'archive-owner',
    agent: { conversationId: original.conversationId, turnId: crypto.randomUUID() },
  })
  if (submitted.kind !== 'created') throw new Error(submitted.kind)
  expect(
    (
      await request(`/${original.id}`, {
        requestId: crypto.randomUUID(),
        baseRevision: 2,
        name: '已删除占位',
        document: { version: 1, elements: [] },
      })
    ).status,
  ).toBe(200)
  const bytes = await sharp({
    create: { width: 32, height: 24, channels: 4, background: '#cc9911' },
  })
    .png()
    .toBuffer()
  setUpstreamFetchForTesting(async () =>
    Response.json({ data: [{ b64_json: bytes.toString('base64') }] }),
  )
  await runTask(submitted.taskId)
  const restored = await (await request(`/${original.id}`)).json()
  expect(restored.document.elements).toEqual([])
  expect(restored.revision).toBe(3)
  const history = await app.handle(
    new Request(`http://localhost/api/generations/${submitted.taskId}`, { headers: { cookie } }),
  )
  expect(await history.json()).toMatchObject({
    status: 'completed',
    archiveStatus: 'ready',
    outputs: [{ index: 0 }],
  })
})

it('项目交付事务失败后只重试保存，保留成功原件，恢复不会再次调用模型', async () => {
  const original = await project()
  const submitted = await createQueueTask({
    provider: 'openai-compat',
    model: 'gpt-image-2',
    request: { prompt: '产品图', device_id: 'archive-device' },
    userId: 'archive-owner',
    agent: { conversationId: original.conversationId, turnId: crypto.randomUUID() },
  })
  if (submitted.kind !== 'created') throw new Error(submitted.kind)
  const bytes = await sharp({
    create: { width: 32, height: 24, channels: 4, background: '#9911cc' },
  })
    .png()
    .toBuffer()
  let calls = 0
  setUpstreamFetchForTesting(async () => {
    calls++
    return Response.json({ data: [{ b64_json: bytes.toString('base64') }] })
  })
  await db.execute(
    sql`CREATE FUNCTION project_delivery_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture delivery transaction unavailable'; END $$`,
  )
  await db.execute(
    sql`CREATE TRIGGER project_delivery_fault BEFORE UPDATE OF document ON canvas_projects FOR EACH ROW EXECUTE FUNCTION project_delivery_fault()`,
  )
  try {
    await runTask(submitted.taskId)
    const detail = await app.handle(
      new Request(`http://localhost/api/generations/${submitted.taskId}`, { headers: { cookie } }),
    )
    expect(await detail.json()).toMatchObject({ status: 'queued', archiveStatus: 'pending' })
    expect((await (await request(`/${original.id}`)).json()).document.elements[0].type).toBe(
      'generation',
    )
  } finally {
    await db.execute(sql`DROP TRIGGER project_delivery_fault ON canvas_projects`)
    await db.execute(sql`DROP FUNCTION project_delivery_fault()`)
  }
  // Retry scheduling is outside the worker boundary under test.
  await db.execute(sql`UPDATE tasks SET next_retry_at = NULL WHERE id = ${submitted.taskId}`)
  await runTask(submitted.taskId)
  const restored = await (await request(`/${original.id}`)).json()
  expect(restored.document.elements).toHaveLength(1)
  expect(restored.document.elements[0].type).toBe('image')
  expect(restored.revision).toBe(3)
  expect(calls).toBe(1)
})

it('取消生成会清除服务端占位，另一个设备不会永远显示生成中', async () => {
  const original = await project()
  const submitted = await createQueueTask({
    provider: 'openai-compat',
    model: 'gpt-image-2',
    request: { prompt: '取消图', device_id: 'archive-device' },
    userId: 'archive-owner',
    agent: { conversationId: original.conversationId, turnId: crypto.randomUUID() },
  })
  if (submitted.kind !== 'created') throw new Error(submitted.kind)
  const response = await app.handle(
    new Request(`http://localhost/v1/queue/requests/${submitted.taskId}/cancel`, {
      method: 'PUT',
      headers: { cookie },
    }),
  )
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ status: 'cancelled' })
  const restored = await (await request(`/${original.id}`)).json()
  expect(restored.document.elements).toEqual([])
  expect(restored.revision).toBe(3)
})

it('最新修订上的旧撤销内容也不能复活已经删除的生成占位', async () => {
  const original = await project()
  const submitted = await createQueueTask({
    provider: 'openai-compat',
    model: 'gpt-image-2',
    request: { prompt: '不可复活', device_id: 'archive-device' },
    userId: 'archive-owner',
    agent: { conversationId: original.conversationId, turnId: crypto.randomUUID() },
  })
  expect(submitted.kind).toBe('created')
  const reserved = await (await request(`/${original.id}`)).json()
  expect(
    (
      await request(`/${original.id}`, {
        requestId: crypto.randomUUID(),
        baseRevision: 2,
        name: reserved.name,
        document: { version: 1, elements: [] },
      })
    ).status,
  ).toBe(200)
  const restore = await request(`/${original.id}`, {
    requestId: crypto.randomUUID(),
    baseRevision: 3,
    name: reserved.name,
    document: reserved.document,
  })
  expect(restore.status).toBe(409)
  expect(await restore.json()).toMatchObject({ error: 'project_output_not_owned' })
})
