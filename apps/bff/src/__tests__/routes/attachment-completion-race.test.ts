import { afterAll, beforeEach, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { DEVICE_ID_HEADER } from '@image-playground/shared'
import sharp from 'sharp'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'

process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-key'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.DATABASE_URL = await resetTestDatabase('bff_attachment_completion_race')
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../attachment-operator-config.json')
const { app } = await import('../../app')
const { db, schema, close } = await import('../../db/client')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
const { setDurableMediaStoreForTesting } = await import('../../lib/durableMediaStore')

class MediaStorage extends InMemoryObjectStore {
  sign(key: string, method: 'GET' | 'PUT') {
    return `https://storage.example.test/${key}?method=${method}`
  }
}
let storage: MediaStorage
let cookie: string
beforeEach(async () => {
  await db.delete(schema.users)
  storage = new MediaStorage()
  setDurableMediaStoreForTesting(storage)
  const now = Date.now()
  await db.insert(schema.users).values({
    id: 'attachment-owner',
    username: 'attachment-owner',
    password_hash: 'fixture',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
  cookie = `${USER_SESSION_COOKIE}=${await db.transaction((tx) => createUserSession('attachment-owner', tx))}`
})
afterAll(close)
function request(path: string, body?: unknown) {
  return app.handle(
    new Request(`http://localhost/api/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        cookie,
        'content-type': 'application/json',
        [DEVICE_ID_HEADER]: 'attachment-device',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  )
}

it('上传确认写原件时回收不能删除其容量或媒体，完成后才可安全清理', async () => {
  const bytes = await sharp({ create: { width: 8, height: 6, channels: 4, background: '#cc4422' } })
    .png()
    .toBuffer()
  const upload = await (
    await request('media/uploads', {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      contentType: 'image/png',
      purpose: 'conversation-attachment',
    })
  ).json()
  await storage.write(new URL(upload.uploadUrl).pathname.slice(1), bytes, 'image/png')
  const write = storage.write.bind(storage)
  let release!: () => void
  let entered!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const writing = new Promise<void>((resolve) => {
    entered = resolve
  })
  storage.write = async (...args) => {
    entered()
    await blocked
    await write(...args)
  }
  const completion = request(`media/${upload.id}/complete`, {})
  await writing
  const { purgeExpiredAttachmentMedia } = await import('../../lib/projectMedia')
  let reclaimed: number
  try {
    reclaimed = await purgeExpiredAttachmentMedia(
      Math.max(upload.leaseExpiresAt, upload.expiresAt) + 60_000,
    )
  } finally {
    release()
  }
  const completed = await completion
  expect(reclaimed).toBe(0)
  expect(completed.status).toBe(200)
  expect((await request(`media/${upload.id}/access`)).status).toBe(200)
  expect(
    await purgeExpiredAttachmentMedia(Math.max(upload.leaseExpiresAt, upload.expiresAt) + 60_000),
  ).toBe(1)
  expect(storage.objects.size).toBe(0)
})
