import { afterAll, beforeEach, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import sharp from 'sharp'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'

process.env.PORT = '0'
process.env.DATABASE_URL = await resetTestDatabase('bff_project_media')
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../project-media-operator-config.json')
const { app } = await import('../../app')
const { db, schema, close } = await import('../../db/client')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
const { setDurableMediaStoreForTesting } = await import('../../lib/durableMediaStore')

class MediaStorage extends InMemoryObjectStore {
  sign(key: string, method: 'GET' | 'PUT', _contentType?: string) {
    return `https://storage.example.test/${key}?method=${method}`
  }
}
let storage: MediaStorage
let deviceA: string
let deviceB: string
let stranger: string
beforeEach(async () => {
  await db.delete(schema.users)
  storage = new MediaStorage()
  setDurableMediaStoreForTesting(storage)
  for (const id of ['media-owner', 'media-stranger']) {
    const now = Date.now()
    await db.insert(schema.users).values({
      id,
      username: id,
      password_hash: 'fixture',
      status: 'active',
      created_at: now,
      updated_at: now,
    })
  }
  const session = async (id: string) =>
    `${USER_SESSION_COOKIE}=${await db.transaction((tx) => createUserSession(id, tx))}`
  deviceA = await session('media-owner')
  deviceB = await session('media-owner')
  stranger = await session('media-stranger')
})
afterAll(close)
function request(path: string, cookie: string, body?: unknown, method = body ? 'POST' : 'GET') {
  return app.handle(
    new Request(`http://localhost/api/${path}`, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  )
}
const key = (url: string) => new URL(url).pathname.slice(1)

it('上传确认后另一设备恢复图片结构，原件直读且旧上传地址不能改写已确认图片', async () => {
  const bytes = await sharp({
    create: { width: 32, height: 24, channels: 4, background: '#cc4422' },
  })
    .png()
    .toBuffer()
  const descriptor = {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    contentType: 'image/png',
  }
  const reserved = await request('media/uploads', deviceA, descriptor)
  expect(reserved.status).toBe(200)
  const upload = await reserved.json()
  expect(upload.status).toBe('pending')
  const image = {
    id: 'photo',
    type: 'image',
    mediaId: upload.id,
    x: 4,
    y: -10,
    width: 320,
    height: 240,
    rotation: 15,
    name: '产品图',
    groupId: 'group-1',
    meta: { prompt: '橙色产品图' },
  }
  const projectId = crypto.randomUUID()
  const write = {
    requestId: crypto.randomUUID(),
    baseRevision: 0,
    name: '图片项目',
    document: { version: 1, elements: [image] },
  }
  expect((await request(`projects/${projectId}`, deviceA, write, 'PUT')).status).toBe(409)
  await storage.write(key(upload.uploadUrl), bytes, 'image/png')
  const completed = await request(`media/${upload.id}/complete`, deviceA, {})
  expect(completed.status).toBe(200)
  expect(await completed.json()).toMatchObject({
    id: upload.id,
    status: 'ready',
    width: 32,
    height: 24,
  })
  expect((await request(`projects/${projectId}`, deviceA, write, 'PUT')).status).toBe(200)
  expect(await (await request(`projects/${projectId}`, deviceB)).json()).toMatchObject({
    document: write.document,
  })
  const listed = await (await request('projects', deviceB)).json()
  expect(listed.projects[0]).toMatchObject({ coverMediaId: upload.id })
  expect(listed.projects[0]).not.toHaveProperty('document')
  const access = await (await request(`media/${upload.id}/access`, deviceB)).json()
  expect(new URL(access.originalUrl).origin).toBe('https://storage.example.test')
  expect(await storage.read(key(access.originalUrl))).toEqual(new Uint8Array(bytes))
  await storage.write(key(upload.uploadUrl), new Uint8Array([1, 2, 3]), 'image/png')
  expect(await storage.read(key(access.originalUrl))).toEqual(new Uint8Array(bytes))
  expect((await request(`media/${upload.id}/access`, stranger)).status).toBe(404)
  expect((await request(`media/${upload.id}/access`, '')).status).toBe(401)
  expect((await request(`media/${upload.id}/complete`, stranger, {})).status).toBe(404)
  expect(await (await request('media/uploads', deviceB, descriptor)).json()).toMatchObject({
    id: upload.id,
    status: 'ready',
  })
})

it('两设备并发预留不能超出总容量，同一内容重复预留不重复占用', async () => {
  const descriptor = { sha256: 'a'.repeat(64), bytes: 100, contentType: 'image/png' }
  const reservations = await Promise.all([
    request('media/uploads', deviceA, descriptor),
    request('media/uploads', deviceB, { ...descriptor, sha256: 'b'.repeat(64) }),
  ])
  expect(reservations.map((response) => response.status).sort()).toEqual([200, 413])
  const successful = await reservations.find((response) => response.status === 200)!.json()
  const replay = await request('media/uploads', deviceB, {
    ...descriptor,
    sha256: reservations[0]!.status === 200 ? descriptor.sha256 : 'b'.repeat(64),
  })
  expect(replay.status).toBe(200)
  expect(await replay.json()).toMatchObject({ id: successful.id })
})

it('真实内容、字节数和摘要必须全部匹配，失败不能让另一设备引用坏图片', async () => {
  const bytes = new Uint8Array([1, 2, 3])
  const descriptor = {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    contentType: 'image/png',
  }
  const upload = await (await request('media/uploads', deviceA, descriptor)).json()
  await storage.write(key(upload.uploadUrl), bytes, 'image/png')
  expect((await request(`media/${upload.id}/complete`, deviceA, {})).status).toBe(422)
  expect((await request(`media/${upload.id}/access`, deviceB)).status).toBe(409)
  await storage.write(key(upload.uploadUrl), new Uint8Array([4, 5, 6]), 'image/png')
  expect(await (await request(`media/${upload.id}/complete`, deviceA, {})).json()).toMatchObject({
    error: 'media_hash_mismatch',
  })
  await storage.write(key(upload.uploadUrl), new Uint8Array([1]), 'image/png')
  expect(await (await request(`media/${upload.id}/complete`, deviceA, {})).json()).toMatchObject({
    error: 'media_size_mismatch',
  })
})

it('对象存储写入缓慢时，同一账号仍能保存画布结构；失败确认可以原身份重试', async () => {
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#ffffff' } })
    .png()
    .toBuffer()
  const upload = await (
    await request('media/uploads', deviceA, {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      contentType: 'image/png',
    })
  ).json()
  await storage.write(key(upload.uploadUrl), bytes, 'image/png')
  const write = storage.write.bind(storage)
  let release!: () => void
  let entered!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  storage.write = async (key, data, type) => {
    entered()
    await blocked
    await write(key, data, type)
  }
  storage.writeFailuresRemaining = 1
  const completion = request(`media/${upload.id}/complete`, deviceA, {})
  await started
  const projectSave = request(
    `projects/${crypto.randomUUID()}`,
    deviceB,
    {
      requestId: crypto.randomUUID(),
      baseRevision: 0,
      name: '仍可编辑',
      document: { version: 1, elements: [] },
    },
    'PUT',
  )
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const status = await Promise.race([
      projectSave.then((response) => response.status),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve('blocked'), 1000)
      }),
    ])
    expect(status).toBe(200)
  } finally {
    if (timeout) clearTimeout(timeout)
    release()
    await projectSave
    await completion
  }
  expect((await completion).status).toBe(503)
  expect((await request(`media/${upload.id}/access`, deviceB)).status).toBe(409)
  expect((await request(`media/${upload.id}/complete`, deviceB, {})).status).toBe(200)
  expect((await request(`media/${upload.id}/access`, deviceB)).status).toBe(200)
})

it('同一份字节改用正确的类型重新预留，沿用原身份并能确认', async () => {
  // 旧版前端按 data URL 上的标签申报，WebP 被报成 png，确认那一步 422。改正后的申报
  // 撞上的是当初那条预留：类型对不上就不能再把它判成坏请求，否则这张图永远上不去。
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#123456' } })
    .webp()
    .toBuffer()
  const descriptor = {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  }
  const mislabeled = await (
    await request('media/uploads', deviceA, { ...descriptor, contentType: 'image/png' })
  ).json()
  await storage.write(key(mislabeled.uploadUrl), bytes, 'image/webp')
  expect(await (await request(`media/${mislabeled.id}/complete`, deviceA, {})).json()).toEqual({
    error: 'media_invalid_image',
  })

  const corrected = await request('media/uploads', deviceA, {
    ...descriptor,
    contentType: 'image/webp',
  })

  expect(corrected.status).toBe(200)
  const upload = await corrected.json()
  expect(upload.id).toBe(mislabeled.id)
  await storage.write(key(upload.uploadUrl), bytes, 'image/webp')
  expect(await (await request(`media/${upload.id}/complete`, deviceA, {})).json()).toMatchObject({
    id: upload.id,
    status: 'ready',
  })
})

it('申报了不收的类型：400 带一行可读原因，而不是整份校验报告的 JSON', async () => {
  const response = await request('media/uploads', deviceA, {
    sha256: 'a'.repeat(64),
    bytes: 716,
    contentType: 'image/svg+xml',
  })

  expect(response.status).toBe(400)
  const body = await response.json()
  expect(body.error).toBe('invalid_request')
  expect(body.message).toStartWith('/contentType: ')
  expect(body.message).not.toContain('\n')
})
