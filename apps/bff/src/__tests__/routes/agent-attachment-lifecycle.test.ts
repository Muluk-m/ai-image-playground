import { afterAll, afterEach, beforeEach, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { AGENT_QUEUE_MAX_PENDING, DEVICE_ID_HEADER } from '@image-playground/shared'
import sharp from 'sharp'
import { completionStream, controlledCompletion, recordingAgentFetch } from '../helpers/agentStubs'
import { silenceChatUpstream } from '../helpers/chatStubs'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { waitFor } from '../helpers/upstreamStubs'

process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-key'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.DATABASE_URL = await resetTestDatabase('bff_agent_attachment_lifecycle')
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../attachment-operator-config.json')
const { app } = await import('../../app')
const { setAgentFetchForTesting } = await import('../../lib/agent/model')
await silenceChatUpstream()
const { db, schema, close } = await import('../../db/client')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
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
  setObjectStoreForTesting(new InMemoryObjectStore())
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
afterEach(() => setAgentFetchForTesting())
afterAll(close)
function request(path: string, body?: unknown, method = body ? 'POST' : 'GET') {
  return app.handle(
    new Request(`http://localhost/api/${path}`, {
      method,
      headers: {
        cookie,
        'content-type': 'application/json',
        [DEVICE_ID_HEADER]: 'attachment-device',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  )
}

it('普通会话附件无需项目即可上传，暂存租约和重复上传保留同一原件身份', async () => {
  const bytes = await sharp({ create: { width: 8, height: 6, channels: 4, background: '#cc4422' } })
    .png()
    .toBuffer()
  const descriptor = {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    contentType: 'image/png',
    purpose: 'conversation-attachment',
  }
  const reserved = await request('media/uploads', descriptor)
  expect(reserved.status).toBe(200)
  const upload = await reserved.json()
  expect(upload.leaseExpiresAt).toBeGreaterThan(Date.now())
  await storage.write(new URL(upload.uploadUrl).pathname.slice(1), bytes, 'image/png')
  const completed = await request(`media/${upload.id}/complete`, {})
  expect(completed.status).toBe(200)
  expect(await completed.json()).toMatchObject({
    id: upload.id,
    status: 'ready',
    width: 8,
    height: 6,
  })
  const replay = await request('media/uploads', descriptor)
  expect(await replay.json()).toMatchObject({ id: upload.id, status: 'ready' })
  const access = await (await request(`media/${upload.id}/access`)).json()
  expect(await storage.read(new URL(access.originalUrl).pathname.slice(1))).toEqual(
    new Uint8Array(bytes),
  )
})

it('附件租约到期删除失败保留容量，重试后只释放一次', async () => {
  const descriptor = {
    sha256: 'a'.repeat(64),
    bytes: 400_000,
    contentType: 'image/png',
    purpose: 'conversation-attachment',
  }
  const upload = await (await request('media/uploads', descriptor)).json()
  await storage.write(new URL(upload.uploadUrl).pathname.slice(1), new Uint8Array([1]), 'image/png')
  const next = { ...descriptor, sha256: 'b'.repeat(64) }
  const { purgeExpiredAttachmentMedia } = await import('../../lib/projectMedia')
  storage.deleteFailuresRemaining = 1
  expect(
    await purgeExpiredAttachmentMedia(Math.max(upload.leaseExpiresAt, upload.expiresAt) + 60_000),
  ).toBe(0)
  expect((await request('media/uploads', next)).status).toBe(413)
  expect(
    await purgeExpiredAttachmentMedia(Math.max(upload.leaseExpiresAt, upload.expiresAt) + 60_000),
  ).toBe(1)
  expect(
    await purgeExpiredAttachmentMedia(Math.max(upload.leaseExpiresAt, upload.expiresAt) + 60_000),
  ).toBe(0)
  expect((await request(`media/${upload.id}/access`)).status).toBe(404)
  expect(storage.objects.size).toBe(0)
  expect((await request('media/uploads', next)).status).toBe(200)
})

it('队列满拒收消息时不认领附件；释放租约后原件可回收', async () => {
  const upstream = controlledCompletion()
  let started = false
  setAgentFetchForTesting(
    recordingAgentFetch([], (signal) => {
      started = true
      return upstream.responseFor(signal)
    }),
  )
  const { conversation } = await (
    await request('agent/conversations', { deviceId: 'attachment-device' })
  ).json()
  const path = `agent/conversations/${conversation.id}`
  const running = await request(`${path}/turns`, {
    deviceId: 'attachment-device',
    text: '等待一下',
  })
  const completion = running.text()
  await waitFor(() => started, 3000)
  try {
    for (let index = 0; index < AGENT_QUEUE_MAX_PENDING; index++) {
      expect(
        (
          await request(`${path}/turns`, {
            deviceId: 'attachment-device',
            text: `排队 ${index}`,
            clientMessageId: `queued-${index}`,
          })
        ).status,
      ).toBe(202)
    }
    const bytes = await sharp({
      create: { width: 8, height: 6, channels: 4, background: '#ffffff' },
    })
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
    expect((await request(`media/${upload.id}/complete`, {})).status).toBe(200)
    expect(
      (
        await request(`${path}/turns`, {
          deviceId: 'attachment-device',
          text: '拒收这张',
          references: [{ imageId: 'file', mediaId: upload.id }],
        })
      ).status,
    ).toBe(409)
    const snapshot = await (await request(`${path}/messages`)).json()
    expect(
      (
        await request(`${path}/turns/${snapshot.activeTurn.turnId}/abort`, {
          deviceId: 'attachment-device',
        })
      ).status,
    ).toBe(200)
    await completion
    const { purgeExpiredAttachmentMedia } = await import('../../lib/projectMedia')
    expect(
      await purgeExpiredAttachmentMedia(Math.max(upload.leaseExpiresAt, upload.expiresAt) + 60_000),
    ).toBe(1)
    expect((await request(`media/${upload.id}/access`)).status).toBe(404)
  } finally {
    try {
      upstream.finish()
    } catch {
      /* The abort endpoint already closed the stream. */
    }
    await completion
  }
})

it('引用发送幂等、历史原件可读，删除一个会话不会删除另一个会话的图片', async () => {
  setAgentFetchForTesting(recordingAgentFetch([], () => completionStream('收到')))
  const bytes = await sharp({ create: { width: 8, height: 6, channels: 4, background: '#123456' } })
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
  expect((await request(`media/${upload.id}/complete`, {})).status).toBe(200)
  const conversationIds: string[] = []
  for (let at = 0; at < 2; at++) {
    const { conversation } = await (
      await request('agent/conversations', { deviceId: 'attachment-device' })
    ).json()
    conversationIds.push(conversation.id)
    const body = {
      deviceId: 'attachment-device',
      text: '看这张图片',
      clientMessageId: 'same-command',
      references: [{ imageId: 'attachment', mediaId: upload.id }],
    }
    const response = await request(`agent/conversations/${conversation.id}/turns`, body)
    expect(response.status).toBe(200)
    await response.text()
    expect((await request(`agent/conversations/${conversation.id}/turns`, body)).status).toBe(202)
    const snapshot = await (await request(`agent/conversations/${conversation.id}/messages`)).json()
    const users = snapshot.messages.filter((message: { role: string }) => message.role === 'user')
    expect(users).toHaveLength(1)
    const original = await request(
      `agent/conversations/${conversation.id}/messages/${users[0].id}/references/0?variant=original`,
    )
    expect(new Uint8Array(await original.arrayBuffer())).toEqual(new Uint8Array(bytes))
  }
  const { purgeExpiredAttachmentMedia } = await import('../../lib/projectMedia')
  expect(
    await purgeExpiredAttachmentMedia(Math.max(upload.leaseExpiresAt, upload.expiresAt) + 60_000),
  ).toBe(0)
  expect(
    (
      await request(
        `agent/conversations/${conversationIds[0]}`,
        { deviceId: 'attachment-device' },
        'DELETE',
      )
    ).status,
  ).toBe(200)
  expect(
    await purgeExpiredAttachmentMedia(Math.max(upload.leaseExpiresAt, upload.expiresAt) + 60_000),
  ).toBe(0)
  expect((await request(`media/${upload.id}/access`)).status).toBe(200)
  expect(
    (
      await request(
        `agent/conversations/${conversationIds[1]}`,
        { deviceId: 'attachment-device' },
        'DELETE',
      )
    ).status,
  ).toBe(200)
  expect(
    await purgeExpiredAttachmentMedia(Math.max(upload.leaseExpiresAt, upload.expiresAt) + 60_000),
  ).toBe(1)
  expect((await request(`media/${upload.id}/access`)).status).toBe(404)
})

it('回收已标删除中时拒绝续租和认领；旧媒体不进入附件回收', async () => {
  const bytes = await sharp({ create: { width: 8, height: 6, channels: 4, background: '#abcdef' } })
    .png()
    .toBuffer()
  const descriptor = {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    contentType: 'image/png',
    purpose: 'conversation-attachment',
  }
  const upload = await (await request('media/uploads', descriptor)).json()
  await storage.write(new URL(upload.uploadUrl).pathname.slice(1), bytes, 'image/png')
  await request(`media/${upload.id}/complete`, {})
  const { conversation } = await (
    await request('agent/conversations', { deviceId: 'attachment-device' })
  ).json()
  let release!: () => void
  let entered!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const deleting = new Promise<void>((resolve) => {
    entered = resolve
  })
  storage.beforeDeletePrefix = async () => {
    entered()
    await blocked
  }
  const { purgeExpiredAttachmentMedia } = await import('../../lib/projectMedia')
  const sweep = purgeExpiredAttachmentMedia(
    Math.max(upload.leaseExpiresAt, upload.expiresAt) + 60_000,
  )
  await deleting
  try {
    expect((await request('media/uploads', descriptor)).status).toBe(409)
    expect(
      (
        await request(`agent/conversations/${conversation.id}/turns`, {
          deviceId: 'attachment-device',
          text: '正在删除',
          references: [{ imageId: 'file', mediaId: upload.id }],
        })
      ).status,
    ).toBe(422)
  } finally {
    release()
  }
  expect(await sweep).toBe(1)
  storage.beforeDeletePrefix = undefined
  const { purpose: _purpose, ...legacy } = descriptor
  const old = await (await request('media/uploads', legacy)).json()
  await storage.write(new URL(old.uploadUrl).pathname.slice(1), bytes, 'image/png')
  expect((await request(`media/${old.id}/complete`, {})).status).toBe(200)
  expect(await purgeExpiredAttachmentMedia(Date.now() + 86400_000)).toBe(0)
  expect((await request(`media/${old.id}/access`)).status).toBe(200)
})

it('短租约就绪附件仍等已签发的暂存上传地址过期后才回收', async () => {
  const bytes = await sharp({ create: { width: 8, height: 6, channels: 4, background: '#fedcba' } })
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
  expect((await request(`media/${upload.id}/complete`, {})).status).toBe(200)
  expect(upload.leaseExpiresAt).toBeLessThan(upload.expiresAt)
  const { purgeExpiredAttachmentMedia } = await import('../../lib/projectMedia')
  expect(await purgeExpiredAttachmentMedia(upload.leaseExpiresAt + 1)).toBe(0)
  expect((await request(`media/${upload.id}/access`)).status).toBe(200)
  expect(await purgeExpiredAttachmentMedia(upload.expiresAt + 1)).toBe(1)
})
