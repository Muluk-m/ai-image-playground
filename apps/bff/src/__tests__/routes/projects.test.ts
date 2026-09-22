import { afterAll, beforeEach, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { PROJECT_DOCUMENT_MAX_BYTES, PROJECT_ELEMENT_MAX_COUNT } from '@image-playground/shared'
import { eq } from 'drizzle-orm'

process.env.PORT = '0'
process.env.DATABASE_URL = await resetTestDatabase('bff_cloud_projects')
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../projects-operator-config.json')

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
    password_hash: 'fixture-hash',
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

const document = {
  version: 1,
  elements: [
    {
      id: 'title',
      type: 'text',
      x: 120,
      y: -30,
      text: '夏日海报',
      fontSize: 64,
      fill: '#ef4444',
      width: 300,
      height: 80,
    },
  ],
}

function request(path: string, cookie: string, body?: unknown) {
  return app.handle(
    new Request(`http://localhost/api/projects${path}`, {
      method: body ? 'PUT' : 'GET',
      headers: { cookie, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  )
}

it('同一用户的另一设备恢复文字画布与名称，目录不携带场景', async () => {
  const id = crypto.randomUUID()
  const saved = await request(`/${id}`, deviceA, {
    requestId: crypto.randomUUID(),
    baseRevision: 0,
    name: '海报项目',
    document,
  })
  expect(saved.status).toBe(200)
  expect(await saved.json()).toMatchObject({ id, name: '海报项目', revision: 1 })
  const reopened = await request(`/${id}`, deviceB)
  expect(reopened.status).toBe(200)
  expect(await reopened.json()).toMatchObject({ id, name: '海报项目', revision: 1, document })
  const list = await (await request('', deviceB)).json()
  expect(list.projects).toHaveLength(1)
  expect(list.projects[0]).toMatchObject({ id, name: '海报项目' })
  expect(list.projects[0]).not.toHaveProperty('document')
})

it('画布类型建项目时定死，后来的写入改不动它', async () => {
  const id = crypto.randomUUID()
  const created = await request(`/${id}`, deviceA, {
    requestId: crypto.randomUUID(),
    baseRevision: 0,
    name: '视频画布',
    document: { ...document, kind: 'video' },
  })
  expect(created.status).toBe(200)
  const rewritten = await request(`/${id}`, deviceA, {
    requestId: crypto.randomUUID(),
    baseRevision: 1,
    name: '视频画布',
    document: { ...document, kind: 'image' },
  })
  expect(rewritten.status).toBe(200)
  expect((await (await request(`/${id}`, deviceB)).json()).document.kind).toBe('video')

  // 这个字段是后加的：不带它的项目一直是图片画布，也不会凭空长出一个。
  const legacy = crypto.randomUUID()
  await request(`/${legacy}`, deviceA, {
    requestId: crypto.randomUUID(),
    baseRevision: 0,
    name: '老项目',
    document,
  })
  await request(`/${legacy}`, deviceA, {
    requestId: crypto.randomUUID(),
    baseRevision: 1,
    name: '老项目',
    document: { ...document, kind: 'video' },
  })
  expect((await (await request(`/${legacy}`, deviceB)).json()).document).not.toHaveProperty('kind')
})

it('拒绝不完整媒体、未知格式及超出边界的结构，保留原文档', async () => {
  const id = crypto.randomUUID()
  const write = (doc: unknown) =>
    request(`/${id}`, deviceA, {
      requestId: crypto.randomUUID(),
      baseRevision: 0,
      name: '结构校验',
      document: doc,
    })
  for (const invalid of [
    { version: 2, elements: [] },
    { version: 1, elements: [{ id: 'image', type: 'image', fileId: 'local-only' }] },
    { version: 1, elements: [document.elements[0], document.elements[0]] },
    { version: 1, elements: [{ ...document.elements[0], x: 'broken' }] },
    { version: 1, elements: [{ ...document.elements[0], text: 'x'.repeat(10001) }] },
    { version: 1, elements: [], files: { secret: 'data:image/png;base64,AAAA' } },
  ]) {
    expect((await write(invalid)).status).toBe(400)
  }
  expect((await request(`/${id}`, deviceB)).status).toBe(404)
})

it('并发旧版本只有一份写入成功，重复请求重放原确认且不能复用请求身份改内容', async () => {
  const id = crypto.randomUUID()
  const original = { requestId: crypto.randomUUID(), baseRevision: 0, name: '原项目', document }
  const first = await (await request(`/${id}`, deviceA, original)).json()
  const competing = await Promise.all([
    request(`/${id}`, deviceA, {
      ...original,
      requestId: crypto.randomUUID(),
      baseRevision: 1,
      name: '设备 A',
    }),
    request(`/${id}`, deviceB, {
      ...original,
      requestId: crypto.randomUUID(),
      baseRevision: 1,
      name: '设备 B',
    }),
  ])
  expect(competing.map((one) => one.status).sort()).toEqual([200, 409])
  expect(await (await request(`/${id}`, deviceA, original)).json()).toEqual(first)
  expect((await request(`/${id}`, deviceA, { ...original, name: '偷换请求' })).status).toBe(409)
  expect(await (await request(`/${id}`, deviceB)).json()).toMatchObject({ revision: 2 })
})

it('项目只归所有者，匿名和其他用户不能读取或覆盖，不能伪造归属字段', async () => {
  const id = crypto.randomUUID()
  const write = { requestId: crypto.randomUUID(), baseRevision: 0, name: '私有项目', document }
  await request(`/${id}`, deviceA, write)
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
  expect((await request(`/${id}`, '')).status).toBe(401)
  expect((await request(`/${id}`, '', write)).status).toBe(401)
  expect((await request(`/${id}`, stranger)).status).toBe(404)
  expect((await request(`/${id}`, stranger, write)).status).toBe(404)
  expect(await (await request('', stranger)).json()).toMatchObject({ projects: [] })
  expect(
    (await request(`/${crypto.randomUUID()}`, deviceA, { ...write, user_id: 'outsider' })).status,
  ).toBe(400)
  expect(await (await request(`/${id}`, deviceB)).json()).toMatchObject({
    revision: 1,
    name: '私有项目',
  })
})

it('目录分页有上界且只返回摘要，结构总字节与元素数有界', async () => {
  for (let n = 0; n < 3; n++)
    await request(`/${crypto.randomUUID()}`, deviceA, {
      requestId: crypto.randomUUID(),
      baseRevision: 0,
      name: `项目 ${n}`,
      document,
    })
  const page = await (await request('?limit=2', deviceB)).json()
  expect(page.projects).toHaveLength(2)
  const second = await (await request(`?limit=2&cursor=${page.nextCursor}`, deviceB)).json()
  expect(second.projects).toHaveLength(1)
  expect(second.nextCursor).toBeNull()
  expect(
    new Set([...page.projects, ...second.projects].map((one: { id: string }) => one.id)).size,
  ).toBe(3)
  for (const query of ['?limit=0', '?limit=101', '?limit=1.5', '?cursor=bad'])
    expect((await request(query, deviceB)).status).toBe(400)
  const id = crypto.randomUUID()
  const write = (elements: unknown[]) =>
    request(`/${id}`, deviceA, {
      requestId: crypto.randomUUID(),
      baseRevision: 0,
      name: '超限',
      document: { version: 1, elements },
    })
  expect(
    (
      await write(
        Array.from({ length: PROJECT_ELEMENT_MAX_COUNT + 1 }, (_, i) => ({
          ...document.elements[0],
          id: `e${i}`,
        })),
      )
    ).status,
  ).toBe(400)
  const tooBig = Array.from({ length: 60 }, (_, i) => ({
    ...document.elements[0],
    id: `e${i}`,
    text: 'x'.repeat(10000),
  }))
  expect(JSON.stringify(tooBig).length).toBeGreaterThan(PROJECT_DOCUMENT_MAX_BYTES)
  expect((await write(tooBig)).status).toBe(400)
  expect((await request(`/${id}`, deviceB)).status).toBe(404)
})

it('并发创建不能突破用户项目数量配额，原有项目仍可编辑', async () => {
  const write = { requestId: crypto.randomUUID(), baseRevision: 0, name: '容量测试', document }
  const original = crypto.randomUUID()
  await request(`/${original}`, deviceA, write)
  const results = await Promise.all(
    Array.from({ length: 3 }, () =>
      request(`/${crypto.randomUUID()}`, deviceB, { ...write, requestId: crypto.randomUUID() }),
    ),
  )
  expect(results.map((one) => one.status).sort()).toEqual([200, 200, 413])
  expect(
    (
      await request(`/${original}`, deviceA, {
        ...write,
        requestId: crypto.randomUUID(),
        baseRevision: 1,
        name: '已重命名',
      })
    ).status,
  ).toBe(200)
  expect((await (await request('', deviceB)).json()).projects).toHaveLength(3)
})

it('单击画笔产生的圆点可连同文字恢复，箭头仍需两个端点', async () => {
  const id = crypto.randomUUID()
  const dot = { id: 'dot', type: 'freedraw', points: [20, 30], stroke: '#ef4444', strokeWidth: 12 }
  const body = {
    requestId: crypto.randomUUID(),
    baseRevision: 0,
    name: '圆点标注',
    document: { version: 1, elements: [document.elements[0], dot] },
  }
  expect((await request(`/${id}`, deviceA, body)).status).toBe(200)
  expect((await (await request(`/${id}`, deviceB)).json()).document.elements).toEqual([
    document.elements[0],
    dot,
  ])
  expect(
    (
      await request(`/${id}`, deviceA, {
        ...body,
        requestId: crypto.randomUUID(),
        baseRevision: 1,
        document: { version: 1, elements: [{ ...dot, type: 'arrow' }] },
      })
    ).status,
  ).toBe(400)
})

it('另一设备删除后旧请求不复活项目，回收恢复保留内容并使旧修订失效', async () => {
  const id = crypto.randomUUID()
  const original = { requestId: crypto.randomUUID(), baseRevision: 0, name: '回收项目', document }
  await request(`/${id}`, deviceA, original)
  const lifecycle = (action: 'delete' | 'restore', cookie = deviceB) =>
    app.handle(
      new Request(`http://localhost/api/projects/${id}${action === 'restore' ? '/restore' : ''}`, {
        method: action === 'restore' ? 'POST' : 'DELETE',
        headers: { cookie },
      }),
    )
  expect((await lifecycle('delete')).status).toBe(200)
  expect((await request('', deviceA)).status).toBe(200)
  expect((await (await request('', deviceA)).json()).projects).toHaveLength(0)
  expect((await request(`/${id}`, deviceA)).status).toBe(410)
  expect((await request(`/${id}`, deviceA, original)).status).toBe(410)
  const trash = await (await request('/trash', deviceA)).json()
  expect(trash.projects).toHaveLength(1)
  expect(trash.projects[0]).toMatchObject({ id, name: '回收项目' })
  expect(trash.projects[0].restoreUntil - trash.projects[0].deletedAt).toBe(30 * 86400000)
  expect((await lifecycle('restore', '')).status).toBe(401)
  expect((await lifecycle('restore')).status).toBe(200)
  expect(await (await request(`/${id}`, deviceA)).json()).toMatchObject({
    id,
    document,
    revision: 3,
  })
  expect((await request(`/${id}`, deviceA, original)).status).toBe(409)
  expect((await (await request('/trash', deviceA)).json()).projects).toHaveLength(0)
})

it('回收项目仍占数量配额；过期项目不可恢复，旧目录游标仍返回墓碑', async () => {
  const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()].sort()
  const write = { requestId: crypto.randomUUID(), baseRevision: 0, name: '容量', document }
  for (const id of ids)
    await request(`/${id}`, deviceA, { ...write, requestId: crypto.randomUUID() })
  const before = await (await request('?limit=1', deviceA)).json()
  const id = ids[0]!
  expect(
    (
      await app.handle(
        new Request(`http://localhost/api/projects/${id}`, {
          method: 'DELETE',
          headers: { cookie: deviceB },
        }),
      )
    ).status,
  ).toBe(200)
  expect((await request(`/${crypto.randomUUID()}`, deviceA, write)).status).toBe(413)
  await db
    .update(schema.canvas_projects)
    .set({ restore_until: Date.now() - 1000 })
    .where(eq(schema.canvas_projects.id, id))
  expect(
    (
      await app.handle(
        new Request(`http://localhost/api/projects/${id}/restore`, {
          method: 'POST',
          headers: { cookie: deviceB },
        }),
      )
    ).status,
  ).toBe(410)
  expect((await request(`/${id}`, deviceA, write)).status).toBe(410)
  expect((await (await request('/trash', deviceA)).json()).projects).toHaveLength(0)
  const continued = await (await request(`?cursor=${before.nextCursor}`, deviceA)).json()
  expect(continued.deletedIds).toContain(id)
  expect(continued.projects.map((one: { id: string }) => one.id)).not.toContain(id)
})
