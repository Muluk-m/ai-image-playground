import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import sharp from 'sharp'

process.env.PORT = '0'
process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com'
process.env.DATABASE_URL = await resetTestDatabase('bff_feedback')
process.env.INTERNAL_API_TOKEN = 'feedback-test-service-token'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../../../operator-config.example.json')
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
process.env.OPENAI_API_KEY = 'test'

const { app } = await import('../../app')
const { close: closeDb, db, schema } = await import('../../db/client')
const { setDurableMediaStoreForTesting } = await import('../../lib/durableMediaStore')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')

const storedObjects = new Map<string, { bytes: Uint8Array; contentType: string }>()

setDurableMediaStoreForTesting({
  async write(key, bytes, contentType) {
    storedObjects.set(key, { bytes: new Uint8Array(bytes), contentType })
  },
  async writeStream(key, stream, contentType) {
    const buffer = await new Response(stream).arrayBuffer()
    storedObjects.set(key, { bytes: new Uint8Array(buffer), contentType })
  },
  async read(key) {
    const item = storedObjects.get(key)
    if (!item) throw new Error(`Object read failed (404)`)
    const copy = new Uint8Array(new ArrayBuffer(item.bytes.byteLength))
    copy.set(item.bytes)
    return copy
  },
  async readUpTo(key, maxBytes) {
    const item = storedObjects.get(key)
    if (!item) throw new Error(`Object read failed (404)`)
    const slice = item.bytes.subarray(0, maxBytes)
    const copy = new Uint8Array(new ArrayBuffer(slice.byteLength))
    copy.set(slice)
    return copy
  },
  async open(key) {
    const item = storedObjects.get(key)
    if (!item) throw new Error(`Object read failed (404)`)
    return {
      size: item.bytes.byteLength,
      stream(start, end) {
        return new ReadableStream({
          start(controller) {
            controller.enqueue(item.bytes.subarray(start, end + 1))
            controller.close()
          },
        })
      },
    }
  },
  async listPrefix(prefix) {
    return [...storedObjects.keys()].filter((key) => key.startsWith(prefix))
  },
  async listEntries(prefix) {
    return [...storedObjects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, size: value.bytes.byteLength, lastModified: Date.now() }))
  },
  async deletePrefix(prefix) {
    for (const key of [...storedObjects.keys()]) {
      if (key.startsWith(prefix)) storedObjects.delete(key)
    }
  },
  sign(key) {
    return `https://signed.example/${key}`
  },
})

const serviceHeaders = {
  authorization: 'Bearer feedback-test-service-token',
  'x-admin-operator': 'ops_nain',
}

const samplePng = await sharp({
  create: { width: 4, height: 4, channels: 4, background: { r: 193, g: 235, b: 148, alpha: 1 } },
})
  .png()
  .toBuffer()

function request(
  path: string,
  method = 'GET',
  body?: BodyInit | Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const isJsonObject =
    body !== undefined &&
    typeof body === 'object' &&
    !(body instanceof FormData) &&
    !(body instanceof Uint8Array) &&
    !(body instanceof Blob)
  return app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        ...headers,
        ...(isJsonObject ? { 'content-type': 'application/json' } : {}),
      },
      body: isJsonObject ? JSON.stringify(body) : (body as BodyInit | undefined),
    }),
  )
}

async function signIn(id: string, nickname?: string): Promise<string> {
  const now = Date.now()
  await db.insert(schema.users).values({
    id,
    username: `${id}@example.com`,
    nickname: nickname ?? null,
    password_hash: 'hash',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
  const token = await db.transaction((tx) => createUserSession(id, tx))
  return `${USER_SESSION_COOKIE}=${token}`
}

beforeEach(async () => {
  storedObjects.clear()
  await db.delete(schema.feedback_messages)
  await db.delete(schema.feedback_threads)
  await db.delete(schema.operator_audits)
  await db.delete(schema.user_sessions)
  await db.delete(schema.users)
})

afterAll(async () => {
  setDurableMediaStoreForTesting(undefined)
  await closeDb()
})

describe('feedback routes', () => {
  it('rejects unauthenticated user and internal requests', async () => {
    expect((await request('/api/feedback')).status).toBe(401)
    expect((await request('/api/feedback/summary')).status).toBe(401)
    expect((await request('/api/feedback/messages', 'POST', { body: 'hi' })).status).toBe(401)
    expect((await request('/internal/admin/feedback')).status).toBe(401)
  })

  it('supports user submission with text + image attachment, admin inbox/reply/resolve, and reopen', async () => {
    const aliceCookie = await signIn('alice', '爱丽丝')
    const bobCookie = await signIn('bob', '鲍勃')

    const empty = await request('/api/feedback', 'GET', undefined, { cookie: aliceCookie })
    expect(empty.status).toBe(200)
    expect(await empty.json()).toEqual({ thread: null, messages: [], hasMore: false })

    const form = new FormData()
    form.set('body', '导出 PNG 时边缘有锯齿')
    form.set('attachment', new File([new Uint8Array(samplePng)], 'bug.png', { type: 'image/png' }))
    const created = await request('/api/feedback/messages', 'POST', form, { cookie: aliceCookie })
    expect(created.status).toBe(201)
    const createdBody = (await created.json()) as {
      thread: { id: string; status: string }
      message: { id: string; body: string; attachment: { mimeType: string; filename: string } }
    }
    expect(createdBody.thread.status).toBe('open')
    expect(createdBody.message.body).toBe('导出 PNG 时边缘有锯齿')
    expect(createdBody.message.attachment).toMatchObject({
      mimeType: 'image/png',
      filename: 'bug.png',
    })

    // User can read own attachment; another user gets 404.
    const ownAsset = await request(
      `/api/feedback/attachments/${createdBody.message.id}`,
      'GET',
      undefined,
      { cookie: aliceCookie },
    )
    expect(ownAsset.status).toBe(200)
    expect(ownAsset.headers.get('content-type')).toBe('image/png')
    expect(ownAsset.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await ownAsset.arrayBuffer())).toEqual(new Uint8Array(samplePng))

    const otherAsset = await request(
      `/api/feedback/attachments/${createdBody.message.id}`,
      'GET',
      undefined,
      { cookie: bobCookie },
    )
    expect(otherAsset.status).toBe(404)

    // Admin sees thread in awaiting_reply filter and can view attachment.
    const adminList = await request(
      '/internal/admin/feedback?filter=awaiting_reply&q=锯齿',
      'GET',
      undefined,
      serviceHeaders,
    )
    expect(adminList.status).toBe(200)
    const listJson = (await adminList.json()) as {
      counts: { all: number; awaitingReply: number; open: number; resolved: number }
      items: Array<{
        id: string
        username: string
        nickname: string
        lastMessageHasAttachment: boolean
      }>
    }
    expect(listJson.counts).toEqual({ all: 1, awaitingReply: 1, open: 1, resolved: 0 })
    expect(listJson.items).toHaveLength(1)
    expect(listJson.items[0]).toMatchObject({
      id: createdBody.thread.id,
      username: 'alice@example.com',
      nickname: '爱丽丝',
      lastMessageHasAttachment: true,
    })

    const adminAsset = await request(
      `/internal/admin/feedback/attachments/${createdBody.message.id}`,
      'GET',
      undefined,
      serviceHeaders,
    )
    expect(adminAsset.status).toBe(200)

    // Admin replies; user sees unreadReplyCount = 1 until marking read.
    const replyRes = await request(
      `/internal/admin/feedback/${createdBody.thread.id}/replies`,
      'POST',
      { body: '已定位到缩放抗锯齿参数，今晚修复上线。' },
      serviceHeaders,
    )
    expect(replyRes.status).toBe(201)

    const summaryBefore = await request('/api/feedback/summary', 'GET', undefined, {
      cookie: aliceCookie,
    })
    expect(await summaryBefore.json()).toEqual({ unreadReplyCount: 1 })

    const firstReply = (await replyRes.json()).message
    const pendingReply = await request(
      `/internal/admin/feedback/${createdBody.thread.id}/replies`,
      'POST',
      { body: '补充：修复会覆盖所有导出尺寸。' },
      serviceHeaders,
    )
    expect(pendingReply.status).toBe(201)
    const { message: secondReply, thread: secondVersion } = await pendingReply.json()
    const readRes = await request(
      '/api/feedback/read',
      'POST',
      { messageId: firstReply.id },
      { cookie: aliceCookie },
    )
    expect(readRes.status).toBe(200)
    expect(await readRes.json()).toEqual({ unreadReplyCount: 1 })

    const thread = await request('/api/feedback', 'GET', undefined, { cookie: aliceCookie })
    const history = await thread.json()
    expect(history.messages.map((message: { id: string }) => message.id)).toEqual([
      createdBody.message.id,
      firstReply.id,
      secondReply.id,
    ])
    expect(history.messages[1].senderLabel).toBeNull()
    expect(history.thread.unreadReplyCount).toBe(1)

    const older = await request(`/api/feedback?before=${secondReply.createdAt}`, 'GET', undefined, {
      cookie: aliceCookie,
    })
    expect((await older.json()).messages.map((message: { id: string }) => message.id)).toEqual([
      createdBody.message.id,
      firstReply.id,
    ])
    const delta = await request(`/api/feedback?after=${firstReply.createdAt}`, 'GET', undefined, {
      cookie: aliceCookie,
    })
    expect((await delta.json()).messages.map((message: { id: string }) => message.id)).toEqual([
      secondReply.id,
    ])

    // Admin resolves thread; user follow-up reopens it.
    const resolved = await request(
      `/internal/admin/feedback/${createdBody.thread.id}/status`,
      'PATCH',
      { status: 'resolved', updatedAt: secondVersion.updatedAt },
      serviceHeaders,
    )
    expect(resolved.status).toBe(200)
    expect((await resolved.json()).thread.status).toBe('resolved')

    const staleStatus = await request(
      `/internal/admin/feedback/${createdBody.thread.id}/status`,
      'PATCH',
      { status: 'open', updatedAt: secondVersion.updatedAt },
      serviceHeaders,
    )
    expect(staleStatus.status).toBe(409)

    const followUp = await request(
      '/api/feedback/messages',
      'POST',
      { body: '补充一张新截图看看' },
      { cookie: aliceCookie },
    )
    expect(followUp.status).toBe(201)
    expect((await followUp.json()).thread).toMatchObject({ status: 'open', unreadReplyCount: 1 })

    const staleResolve = await request(
      `/internal/admin/feedback/${createdBody.thread.id}/status`,
      'PATCH',
      { status: 'resolved', updatedAt: secondVersion.updatedAt },
      serviceHeaders,
    )
    expect(staleResolve.status).toBe(409)
    expect((await staleResolve.json()).error).toBe('stale_thread')

    const finalRead = await request(
      '/api/feedback/read',
      'POST',
      { messageId: secondReply.id },
      {
        cookie: aliceCookie,
      },
    )
    expect(await finalRead.json()).toEqual({ unreadReplyCount: 0 })

    const audits = await db.select().from(schema.operator_audits)
    expect(audits.map((row) => row.action).sort()).toEqual([
      'feedback.reply',
      'feedback.reply',
      'feedback.status',
    ])
  })

  it('bounds message history and exposes a cursor for the older page', async () => {
    const cookie = await signIn('page-test')
    const first = await request(
      '/api/feedback/messages',
      'POST',
      { body: 'First message' },
      { cookie },
    )
    const created = await first.json()
    const timestamp = created.message.createdAt
    await db.insert(schema.feedback_messages).values(
      Array.from({ length: 21 }, (_, index) => ({
        id: `page-message-${index}`,
        thread_id: created.thread.id,
        sender_type: 'user' as const,
        sender_user_id: 'page-test',
        body: `Message ${index}`,
        created_at: timestamp + index + 1,
      })),
    )

    const recent = await (await request('/api/feedback', 'GET', undefined, { cookie })).json()
    expect(recent.messages).toHaveLength(20)
    expect(recent.hasMore).toBe(true)
    const older = await (
      await request(`/api/feedback?before=${recent.messages[0].createdAt}`, 'GET', undefined, {
        cookie,
      })
    ).json()
    expect(older.messages.map((message: { body: string }) => message.body)).toEqual([
      'First message',
      'Message 0',
    ])
    expect(older.hasMore).toBe(false)
  })

  it('rejects a feedback write from an untrusted browser origin', async () => {
    const cookie = await signIn('origin-test')
    const response = await request(
      '/api/feedback/messages',
      'POST',
      { body: 'test' },
      {
        cookie,
        origin: 'https://untrusted.example.com',
      },
    )
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'forbidden_origin' })
  })

  it('rejects empty messages and spoofed or non-image attachments', async () => {
    const cookie = await signIn('tester')

    const empty = await request('/api/feedback/messages', 'POST', { body: '   ' }, { cookie })
    expect(empty.status).toBe(400)
    expect(await empty.json()).toEqual({ error: 'empty_message' })

    const spoofed = new FormData()
    spoofed.set('body', '伪装文件')
    spoofed.set('attachment', new File(['not-a-png'], 'fake.png', { type: 'image/png' }))
    const rejected = await request('/api/feedback/messages', 'POST', spoofed, { cookie })
    expect(rejected.status).toBe(400)
    expect(await rejected.json()).toEqual({ error: 'attachment_type' })
  })
})
