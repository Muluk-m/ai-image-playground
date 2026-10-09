import { afterAll, afterEach, beforeEach, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { DEVICE_ID_HEADER } from '@image-playground/shared'
import sharp from 'sharp'
import { type AgentCall, completionStream, recordingAgentFetch } from '../helpers/agentStubs'
import { silenceChatUpstream } from '../helpers/chatStubs'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'

process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-key'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.DATABASE_URL = await resetTestDatabase('bff_bulk_attachment_intake')
process.env.OPERATOR_CONFIG_FILE = resolve(
  import.meta.dir,
  '../bulk-attachment-operator-config.json',
)
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

it('100 logical attachments retain ordered identities through retry and history while 101 is rejected', async () => {
  const manifest = await (await request('capabilities')).json()
  expect(manifest.attachmentLimits).toEqual({
    logicalReferences: 100,
    imageBytes: 1024,
    imagePixels: 48,
    uploadConcurrency: 2,
  })
  setAgentFetchForTesting(recordingAgentFetch([], () => completionStream('已收到全部100张引用')))
  const bytes = await sharp({ create: { width: 8, height: 6, channels: 4, background: '#123456' } })
    .png()
    .toBuffer()
  const descriptor = {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    contentType: 'image/png',
    purpose: 'conversation-attachment',
  }
  const uploaded = await request('media/uploads', descriptor)
  expect(uploaded.status).toBe(200)
  const upload = await uploaded.json()
  await storage.write(new URL(upload.uploadUrl).pathname.slice(1), bytes, 'image/png')
  expect((await request(`media/${upload.id}/complete`, {})).status).toBe(200)
  expect(await (await request('media/uploads', descriptor)).json()).toMatchObject({
    id: upload.id,
    status: 'ready',
  })
  const { conversation } = await (
    await request('agent/conversations', { deviceId: 'attachment-device' })
  ).json()
  const path = `agent/conversations/${conversation.id}`
  const references = Array.from({ length: 100 }, (_, index) => ({
    imageId: `image-${index}`,
    name: `source-${index}.png`,
    mediaId: upload.id,
  }))
  const body = {
    deviceId: 'attachment-device',
    text: '保存完整引用',
    clientMessageId: 'bulk-once',
    references,
  }
  const accepted = await request(`${path}/turns`, body)
  expect(accepted.status).toBe(200)
  await accepted.text()
  expect((await request(`${path}/turns`, body)).status).toBe(202)
  const tooMany = await request(`${path}/turns`, {
    ...body,
    clientMessageId: 'bulk-too-many',
    references: [...references, { imageId: 'image-100', mediaId: upload.id }],
  })
  expect(tooMany.status).toBe(400)
  const snapshot = await (await request(`${path}/messages`)).json()
  const users = snapshot.messages.filter((message: { role: string }) => message.role === 'user')
  expect(users).toHaveLength(1)
  expect(
    users[0].content.flatMap((block: { references?: unknown[] }) => block.references ?? []),
  ).toEqual(references)
  const last = await request(`${path}/messages/${users[0].id}/references/99?variant=original`)
  expect(last.status).toBe(200)
  expect(new Uint8Array(await last.arrayBuffer())).toEqual(new Uint8Array(bytes))
  const rollback = Bun.spawn(
    [
      process.execPath,
      '--eval',
      String.raw`
    const input = await new Response(Bun.stdin.stream()).json()
    const { app } = await import('./src/app')
    const { close } = await import('./src/db/client')
    const { InMemoryObjectStore } = await import('./src/__tests__/helpers/inMemoryObjectStore')
    const { setDurableMediaStoreForTesting } = await import('./src/lib/durableMediaStore')
    const { setAgentFetchForTesting } = await import('./src/lib/agent/model')
    const { recordingAgentFetch, completionStream } = await import('./src/__tests__/helpers/agentStubs')
    const { createHash } = await import('node:crypto')
    const store = new InMemoryObjectStore()
    for (const object of input.objects) await store.write(object.key, new Uint8Array(object.bytes), object.contentType)
    setDurableMediaStoreForTesting(store)
    setAgentFetchForTesting(recordingAgentFetch([], () => completionStream('旧上限继续可用')))
    const headers = { cookie: input.cookie, 'content-type': 'application/json', 'x-device-id': 'attachment-device' }
    const request = (path, body) => app.handle(new Request('http://localhost/api/' + path, { method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}) }))
    try {
      const manifest = await (await request('capabilities')).json()
      const original = await request(input.path + '/messages/' + input.messageId + '/references/99?variant=original')
      const digest = createHash('sha256').update(new Uint8Array(await original.arrayBuffer())).digest('hex')
      const tooMany = await request(input.path + '/turns', { ...input.body, clientMessageId: 'rollback-51', references: input.body.references.slice(0, 51) })
      const legacy = await request(input.path + '/turns', { ...input.body, clientMessageId: 'rollback-50', references: input.body.references.slice(0, 50) })
      await legacy.text()
      const snapshot = await (await request(input.path + '/messages')).json()
      process.stdout.write('ROLLBACK_RESULT:' + JSON.stringify({ manifest, readStatus: original.status, digest, tooManyStatus: tooMany.status, legacyStatus: legacy.status, userCount: snapshot.messages.filter(message => message.role === 'user').length }) + '\n')
    } finally { await close() }
  `,
    ],
    {
      cwd: resolve(import.meta.dir, '../../..'),
      env: {
        ...process.env,
        OPERATOR_CONFIG_FILE: resolve(import.meta.dir, '../attachment-operator-config.json'),
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  rollback.stdin.write(
    JSON.stringify({
      cookie,
      path,
      messageId: users[0].id,
      body,
      objects: [...storage.objects].map(([key, object]) => ({
        key,
        bytes: [...object.bytes],
        contentType: object.contentType,
      })),
    }),
  )
  rollback.stdin.end()
  const timeout = setTimeout(() => rollback.kill(), 20_000)
  try {
    const [output, errors, exitCode] = await Promise.all([
      new Response(rollback.stdout).text(),
      new Response(rollback.stderr).text(),
      rollback.exited,
    ])
    if (exitCode !== 0) throw new Error(`Rollback fixture exited ${exitCode}: ${errors}`)
    const resultLine = output.split('\n').find((line) => line.startsWith('ROLLBACK_RESULT:'))
    expect(resultLine).toBeDefined()
    const result = JSON.parse(resultLine!.slice('ROLLBACK_RESULT:'.length))
    expect(result.manifest['agent:bulk-attachments']).toBe(false)
    expect(result.manifest).not.toHaveProperty('attachmentLimits')
    expect(result.readStatus).toBe(200)
    expect(result.digest).toBe(descriptor.sha256)
    expect(result.tooManyStatus).toBe(422)
    expect(result.legacyStatus).toBe(200)
    expect(result.userCount).toBe(2)
  } finally {
    clearTimeout(timeout)
  }
}, 30_000)

it('enforces advertised original budgets on uploads and existing project media before accepting a message', async () => {
  const oversized = await request('media/uploads', {
    sha256: 'a'.repeat(64),
    bytes: 1025,
    contentType: 'image/png',
    purpose: 'conversation-attachment',
  })
  expect(oversized.status).toBe(413)
  expect(await oversized.json()).toEqual({ error: 'media_too_large' })
  const upload = async (width: number, height: number, attachment: boolean) => {
    const bytes = await sharp({ create: { width, height, channels: 4, background: '#224466' } })
      .png()
      .toBuffer()
    const response = await request('media/uploads', {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      contentType: 'image/png',
      ...(attachment ? { purpose: 'conversation-attachment' } : {}),
    })
    expect(response.status).toBe(200)
    const reserved = await response.json()
    await storage.write(new URL(reserved.uploadUrl).pathname.slice(1), bytes, 'image/png')
    return reserved
  }
  const tooManyPixels = await upload(8, 7, true)
  const rejectedCompletion = await request(`media/${tooManyPixels.id}/complete`, {})
  expect(rejectedCompletion.status).toBe(422)
  expect(await rejectedCompletion.json()).toEqual({ error: 'media_image_pixels_exceeded' })
  const projectImage = await upload(9, 6, false)
  expect((await request(`media/${projectImage.id}/complete`, {})).status).toBe(200)
  const calls: AgentCall[] = []
  setAgentFetchForTesting(recordingAgentFetch(calls, () => completionStream('不应调用')))
  const { conversation } = await (
    await request('agent/conversations', { deviceId: 'attachment-device' })
  ).json()
  const path = `agent/conversations/${conversation.id}`
  const refused = await request(`${path}/turns`, {
    deviceId: 'attachment-device',
    text: '不可绕过图片限制',
    clientMessageId: 'too-large-project-image',
    references: [{ imageId: 'project-image', mediaId: projectImage.id }],
  })
  expect(refused.status).toBe(422)
  expect((await (await request(`${path}/messages`)).json()).messages).toEqual([])
  expect(calls).toHaveLength(0)
  expect((await request(`media/${projectImage.id}/access`)).status).toBe(200)
})

it('accepts a 3000 by 2700 JPEG original under the 40 megapixel attachment budget', async () => {
  const { config } = await import('../../config')
  const previous = config.operator
  config.operator = {
    ...previous,
    quotas: {
      ...previous.quotas,
      'agent:attachment-image-bytes': 10 * 1024 * 1024,
      'agent:attachment-image-pixels': 40_000_000,
    },
  }
  try {
    const manifest = await (await request('capabilities')).json()
    expect(manifest.attachmentLimits.imagePixels).toBe(40_000_000)
    const bytes = await sharp({
      create: { width: 3000, height: 2700, channels: 3, background: '#eeeeee' },
    })
      .jpeg()
      .toBuffer()
    const descriptor = {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      contentType: 'image/jpeg',
      purpose: 'conversation-attachment',
    }
    const reserved = await request('media/uploads', descriptor)
    expect(reserved.status).toBe(200)
    const upload = await reserved.json()
    await storage.write(new URL(upload.uploadUrl).pathname.slice(1), bytes, 'image/jpeg')
    const complete = await request(`media/${upload.id}/complete`, {})
    expect(complete.status).toBe(200)
    expect(await complete.json()).toMatchObject({ status: 'ready', width: 3000, height: 2700 })
    const access = await (await request(`media/${upload.id}/access`)).json()
    expect(storage.objects.get(new URL(access.originalUrl).pathname.slice(1))?.bytes).toEqual(
      new Uint8Array(bytes),
    )
  } finally {
    config.operator = previous
  }
})
