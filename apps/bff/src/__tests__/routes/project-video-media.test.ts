import { afterAll, afterEach, beforeEach, expect, it, spyOn } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'

process.env.PORT = '0'
process.env.DATABASE_URL = await resetTestDatabase('project_video_media')
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../projects-operator-config.json')
const { app } = await import('../../app')
const { db, schema, close } = await import('../../db/client')
const { config } = await import('../../config')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { setDurableMediaStoreForTesting } = await import('../../lib/durableMediaStore')
class MediaStore extends InMemoryObjectStore {
  sign(key: string) {
    return `https://fixture.invalid/${key}`
  }
}
let source: InMemoryObjectStore
let durable: MediaStore
let owner: string
let stranger: string
const video = Uint8Array.from([
  0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 105, 115, 111, 109, 109, 112, 52,
  50,
])
const operator = config.operator
beforeEach(async () => {
  await db.delete(schema.tasks)
  await db.delete(schema.users)
  source = new InMemoryObjectStore()
  durable = new MediaStore()
  setObjectStoreForTesting(source)
  setDurableMediaStoreForTesting(durable)
  for (const id of ['video-owner', 'video-stranger'])
    await db.insert(schema.users).values({
      id,
      username: id,
      password_hash: 'fixture',
      status: 'active',
      created_at: 1,
      updated_at: 1,
    })
  owner = `${USER_SESSION_COOKIE}=${await db.transaction((tx) => createUserSession('video-owner', tx))}`
  stranger = `${USER_SESSION_COOKIE}=${await db.transaction((tx) => createUserSession('video-stranger', tx))}`
  await source.write('video-task/out/0', video, 'video/mp4')
  await db.insert(schema.tasks).values({
    id: 'video-task',
    provider: 'openai-compat',
    model: 'fixture-video',
    status: 'completed',
    user_id: 'video-owner',
    submitted_at: 1,
    completed_at: 2,
    request_payload: { prompt: 'fixture' },
    result_payload: { data: [{ object: 'video-task/out/0', mime: 'video/mp4' }] },
  })
})
afterEach(() => {
  config.operator = operator
  setObjectStoreForTesting()
  setDurableMediaStoreForTesting()
})
afterAll(close)
const adopt = (cookie = owner, index = 0) =>
  app.handle(
    new Request('http://localhost/api/media/video-outputs', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: 'video-task', outputIndex: index }),
    }),
  )
const content = (id: string, cookie = owner, range?: string) =>
  app.handle(
    new Request(`http://localhost/api/media/${id}/content`, {
      headers: { cookie, ...(range ? { range } : {}) },
    }),
  )

it('promotes only the owned video, deduplicates capacity and serves ranges after queue expiry', async () => {
  expect((await adopt(stranger)).status).toBe(404)
  expect((await adopt(owner, 1)).status).toBe(404)
  const response = await adopt()
  expect(response.status).toBe(200)
  const media = await response.json()
  expect(media).toMatchObject({ status: 'ready', bytes: video.length, contentType: 'video/mp4' })
  expect((await (await adopt()).json()).id).toBe(media.id)
  const rows = await db.select().from(schema.media_objects)
  expect(rows).toHaveLength(1)
  expect(rows[0]?.reserved_bytes).toBe(video.length)
  expect(rows[0]?.object_key?.startsWith('objects/')).toBe(true)
  await db.delete(schema.tasks)
  await source.deletePrefix('video-task/')
  const full = await content(media.id)
  expect(full.status).toBe(200)
  expect(new Uint8Array(await full.arrayBuffer())).toEqual(video)
  const partial = await content(media.id, owner, 'bytes=4-7')
  expect(partial.status).toBe(206)
  expect(partial.headers.get('content-range')).toBe(`bytes 4-7/${video.length}`)
  expect(await partial.text()).toBe('ftyp')
  expect((await content(media.id, stranger)).status).toBe(404)
  expect((await content(media.id, owner, 'bytes=999-')).status).toBe(416)
  expect(source.events.some((event) => event.startsWith('read:'))).toBe(false)
})

it('checks capacity before copying and leaves a failed promotion retryable', async () => {
  config.operator = { ...operator, quotas: { ...operator.quotas, 'sync:user-media-bytes': 1 } }
  expect((await adopt()).status).toBe(413)
  expect(await durable.listPrefix('objects/')).toEqual([])
  config.operator = operator
  durable.writeFailuresRemaining = 1
  expect((await adopt()).status).toBe(503)
  expect(await durable.listPrefix('objects/')).toEqual([])
  expect((await adopt()).status).toBe(200)
})

it('rejects size/header mismatch and does not publish a source that changes during copying', async () => {
  await source.write('video-task/out/0', new Uint8Array(24), 'video/mp4')
  expect((await adopt()).status).toBe(422)
  await source.write('video-task/out/0', video, 'video/mp4')
  const original = source.open.bind(source)
  let opens = 0
  const opening = spyOn(source, 'open').mockImplementation(async (key) => {
    if (++opens === 2)
      await source.write(key, Uint8Array.from([...video.slice(0, -1), 99]), 'video/mp4')
    return original(key)
  })
  try {
    expect((await adopt()).status).toBe(422)
    expect(
      await db.select().from(schema.media_objects).where(eq(schema.media_objects.status, 'ready')),
    ).toEqual([])
    expect(await durable.listPrefix('objects/')).toEqual([])
  } finally {
    opening.mockRestore()
  }
})

it('refuses publication if another upload changes the reservation during video copying', async () => {
  const write = durable.writeStream.bind(durable)
  const copying = spyOn(durable, 'writeStream').mockImplementation(async (key, stream, mime) => {
    const [row] = await db.select().from(schema.media_objects)
    const changed = await app.handle(
      new Request('http://localhost/api/media/uploads', {
        method: 'POST',
        headers: { cookie: owner, 'content-type': 'application/json' },
        body: JSON.stringify({ sha256: row!.sha256, bytes: 10, contentType: 'image/png' }),
      }),
    )
    expect(changed.status).toBe(200)
    return write(key, stream, mime)
  })
  try {
    expect((await adopt()).status).toBe(409)
    expect(
      await db.select().from(schema.media_objects).where(eq(schema.media_objects.status, 'ready')),
    ).toEqual([])
    expect(await durable.listPrefix('objects/')).toEqual([])
  } finally {
    copying.mockRestore()
  }
  expect((await adopt()).status).toBe(200)
})
