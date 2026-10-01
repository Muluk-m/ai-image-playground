import { afterAll, afterEach, beforeEach, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import {
  type AgentMediaReference,
  type AgentMessageView,
  DEVICE_ID_HEADER,
} from '@image-playground/shared'
import sharp from 'sharp'
import {
  type AgentCall,
  completionStream,
  confirmPendingDrafts,
  controlledCompletion,
  readFrames,
  recordingAgentFetch,
  scriptedAgentFetch,
  TEST_IMAGE_CHANNEL,
  toolCallCompletion,
} from '../helpers/agentStubs'
import { silenceChatUpstream } from '../helpers/chatStubs'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { waitFor } from '../helpers/upstreamStubs'

process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-key'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.DATABASE_URL = await resetTestDatabase('bff_agent_mask_attachments')
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../attachment-operator-config.json')
const { _setPrivateBffOverlayForTesting, EMPTY_PRIVATE_BFF_OVERLAY } = await import(
  '../../lib/private-overlay'
)
_setPrivateBffOverlayForTesting(EMPTY_PRIVATE_BFF_OVERLAY)
const { app } = await import('../../app')
const { setAgentFetchForTesting } = await import('../../lib/agent/model')
await silenceChatUpstream()
const { db, schema, close } = await import('../../db/client')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { setDurableMediaStoreForTesting } = await import('../../lib/durableMediaStore')
const { _setChannelsForTesting } = await import('../../lib/channels')
const { setUpstreamFetchForTesting } = await import('../../lib/upstream')
const { runTask } = await import('../../workers/task-runner')

class MediaStorage extends InMemoryObjectStore {
  beforeRead?: () => Promise<void>
  override async read(key: string) {
    await this.beforeRead?.()
    return super.read(key)
  }
  override async open(key: string) {
    await this.beforeRead?.()
    return super.open(key)
  }
  sign(key: string, method: 'GET' | 'PUT') {
    return `https://storage.example.test/${key}?method=${method}`
  }
}
let storage: MediaStorage
let cookie: string
const deviceId = 'mask-attachment-device'
beforeEach(async () => {
  await db.delete(schema.tasks)
  await db.delete(schema.agent_conversations)
  await db.delete(schema.users)
  storage = new MediaStorage()
  setDurableMediaStoreForTesting(storage)
  setObjectStoreForTesting(new InMemoryObjectStore())
  _setChannelsForTesting([TEST_IMAGE_CHANNEL])
  const now = Date.now()
  await db.insert(schema.users).values({
    id: 'mask-owner',
    username: 'mask-owner',
    password_hash: 'fixture',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
  cookie = `${USER_SESSION_COOKIE}=${await db.transaction((tx) => createUserSession('mask-owner', tx))}`
})
afterEach(() => {
  setAgentFetchForTesting()
  setUpstreamFetchForTesting()
  setObjectStoreForTesting()
  setDurableMediaStoreForTesting()
})
afterAll(close)

function request(path: string, body?: unknown, method = body ? 'POST' : 'GET') {
  return app.handle(
    new Request(`http://localhost/api/${path}`, {
      method,
      headers: { cookie, 'content-type': 'application/json', [DEVICE_ID_HEADER]: deviceId },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  )
}

async function upload(bytes: Buffer) {
  const reserved = await request('media/uploads', {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    contentType: 'image/png',
    purpose: 'conversation-attachment',
  })
  expect(reserved.status).toBe(200)
  const media = await reserved.json()
  await storage.write(new URL(media.uploadUrl).pathname.slice(1), bytes, 'image/png')
  expect((await request(`media/${media.id}/complete`, {})).status).toBe(200)
  return media
}

it('reopens a complete media selection and submits its unchanged original and mask to generation', async () => {
  const source = await sharp({
    create: { width: 1024, height: 1024, channels: 4, background: '#dd4422' },
  })
    .png()
    .toBuffer()
  const mask = await sharp({
    create: { width: 1024, height: 1024, channels: 4, background: '#00000000' },
  })
    .png()
    .toBuffer()
  const original = await upload(source)
  const selection = await upload(mask)
  const reference: AgentMediaReference = {
    imageId: 'selected-photo',
    mediaId: original.id,
    maskMediaId: selection.id,
    editAction: 'inpaint',
    regions: [{ x: 0, y: 0, width: 1, height: 1 }],
  }
  const calls: AgentCall[] = []
  setAgentFetchForTesting(
    scriptedAgentFetch(calls, [
      () =>
        toolCallCompletion({
          id: 'read-selection',
          name: 'viewImage',
          args: { imageIds: ['selected-photo'] },
        }),
      () => {
        const selectionId = JSON.stringify(calls).match(/selection_[a-f0-9]{64}/)?.[0]
        return toolCallCompletion({
          id: 'edit-selection',
          name: 'editImage',
          args: {
            imageIds: ['selected-photo'],
            prompt: '只把选区改成蓝色，其他不变',
            selectionBindings: [{ imageId: 'selected-photo', selectionId }],
          },
        })
      },
      () => completionStream('请确认生成'),
    ]),
  )
  const { conversation } = await (await request('agent/conversations', { deviceId })).json()
  const path = `agent/conversations/${conversation.id}`
  const turn = await request(`${path}/turns`, {
    deviceId,
    text: '只把选区改成蓝色，其他不变',
    references: [reference],
  })
  expect(turn.status).toBe(200)
  await turn.text()
  const snapshot = (await (await request(`${path}/messages`)).json()) as {
    messages: AgentMessageView[]
  }
  const user = snapshot.messages.find((message) => message.role === 'user')!
  const references = user.content.flatMap((block) =>
    block.type === 'text' ? (block.references ?? []) : [],
  )
  expect(references).toEqual([reference])
  const originalResponse = await request(
    `${path}/messages/${user.id}/references/0?variant=original`,
  )
  expect(Buffer.from(await originalResponse.arrayBuffer())).toEqual(source)
  const cards = await confirmPendingDrafts(app, conversation.id, { deviceId, cookie })
  expect(cards).toHaveLength(1)
  expect(cards[0]!.status).toBe('submitted')
  const sent: { original: Buffer; mask: Buffer; prompt: string }[] = []
  setUpstreamFetchForTesting(async (_input, init) => {
    const form = init!.body as FormData
    sent.push({
      original: Buffer.from(await (form.get('image[]') as Blob).arrayBuffer()),
      mask: Buffer.from(await (form.get('mask') as Blob).arrayBuffer()),
      prompt: String(form.get('prompt')),
    })
    return Response.json({ data: [{ b64_json: source.toString('base64') }] })
  })
  await runTask(cards[0]!.job!.taskId)
  expect(sent).toHaveLength(1)
  expect(sent[0]!.original).toEqual(source)
  expect(sent[0]!.mask).toEqual(mask)
  expect(sent[0]!.prompt).toContain('selection_')
})

it('rejects a mismatched mask before accepting any part of the message or retaining either object', async () => {
  setAgentFetchForTesting(recordingAgentFetch([], () => completionStream('收到')))
  const original = await upload(
    await sharp({
      create: { width: 1024, height: 1024, channels: 4, background: '#aabbcc' },
    })
      .png()
      .toBuffer(),
  )
  const mask = await upload(
    await sharp({
      create: { width: 512, height: 512, channels: 4, background: '#00000000' },
    })
      .png()
      .toBuffer(),
  )
  const { conversation } = await (await request('agent/conversations', { deviceId })).json()
  const path = `agent/conversations/${conversation.id}`
  const response = await request(`${path}/turns`, {
    deviceId,
    text: '只修改选区',
    references: [{ imageId: 'photo', mediaId: original.id, maskMediaId: mask.id }],
  })
  const status = response.status
  await response.text()
  expect(status).toBe(422)
  const snapshot = await (await request(`${path}/messages`)).json()
  expect(snapshot.messages).toEqual([])
  const { purgeExpiredAttachmentMedia } = await import('../../lib/projectMedia')
  expect(
    await purgeExpiredAttachmentMedia(
      Math.max(original.expiresAt, mask.expiresAt, original.leaseExpiresAt, mask.leaseExpiresAt) +
        60_000,
    ),
  ).toBe(2)
  expect((await request(`media/${original.id}/access`)).status).toBe(404)
  expect((await request(`media/${mask.id}/access`)).status).toBe(404)
})

it('does not retain either attachment or a partial message when a turn stops during interjection preparation', async () => {
  const original = await upload(
    await sharp({
      create: { width: 1024, height: 1024, channels: 4, background: '#998877' },
    })
      .png()
      .toBuffer(),
  )
  const mask = await upload(
    await sharp({
      create: { width: 1024, height: 1024, channels: 4, background: '#00000000' },
    })
      .png()
      .toBuffer(),
  )
  const first = controlledCompletion()
  let started = false
  setAgentFetchForTesting(
    recordingAgentFetch([], (signal) => {
      started = true
      return first.responseFor(signal)
    }),
  )
  const { conversation } = await (await request('agent/conversations', { deviceId })).json()
  const path = `agent/conversations/${conversation.id}`
  const running = await request(`${path}/turns`, { deviceId, text: '先等一下' })
  const completed = running.text()
  await waitFor(() => started, 3000)
  const snapshot = await (await request(`${path}/messages`)).json()
  const turnId = snapshot.activeTurn.turnId
  let release!: () => void
  let entered!: () => void
  const reading = new Promise<void>((resolve) => {
    entered = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  storage.beforeRead = async () => {
    storage.beforeRead = undefined
    entered()
    await held
  }
  const interjecting = request(`${path}/turns/${turnId}/interject`, {
    deviceId,
    text: '只修改这张图的选区',
    references: [{ imageId: 'photo', mediaId: original.id, maskMediaId: mask.id }],
  })
  try {
    await reading
    expect((await request(`${path}/turns/${turnId}/abort`, { deviceId })).status).toBe(200)
    await completed
    release()
    expect((await interjecting).status).toBe(409)
    const history = (await (await request(`${path}/messages`)).json()) as {
      messages: AgentMessageView[]
    }
    expect(history.messages.filter((message) => message.role === 'user')).toHaveLength(1)
    const { purgeExpiredAttachmentMedia } = await import('../../lib/projectMedia')
    expect(
      await purgeExpiredAttachmentMedia(
        Math.max(original.expiresAt, mask.expiresAt, original.leaseExpiresAt, mask.leaseExpiresAt) +
          60_000,
      ),
    ).toBe(2)
    expect((await request(`media/${original.id}/access`)).status).toBe(404)
    expect((await request(`media/${mask.id}/access`)).status).toBe(404)
  } finally {
    release()
    storage.beforeRead = undefined
    await interjecting
  }
})

it('accepts an interjection once and preserves the complete surrounding assistant stream', async () => {
  const original = await upload(
    await sharp({
      create: { width: 1024, height: 1024, channels: 4, background: '#779988' },
    })
      .png()
      .toBuffer(),
  )
  const mask = await upload(
    await sharp({
      create: { width: 1024, height: 1024, channels: 4, background: '#00000000' },
    })
      .png()
      .toBuffer(),
  )
  const reference = { imageId: 'photo', mediaId: original.id, maskMediaId: mask.id }
  const first = controlledCompletion()
  const calls: AgentCall[] = []
  setAgentFetchForTesting(
    recordingAgentFetch(calls, (signal) =>
      calls.length === 1 ? first.responseFor(signal) : completionStream('已收到选区'),
    ),
  )
  const { conversation } = await (await request('agent/conversations', { deviceId })).json()
  const path = `agent/conversations/${conversation.id}`
  const running = await request(`${path}/turns`, { deviceId, text: '先聊聊' })
  first.push('原回复前半段')
  const frames = await readFrames(running, 3)
  const start = frames[0]!.event
  if (start.type !== 'turnStart') throw new Error('turn did not start')
  const interjectPath = `${path}/turns/${start.turnId}/interject`
  const body = {
    deviceId,
    clientMessageId: crypto.randomUUID(),
    text: '只修改这张图的选区',
    references: [reference],
  }
  try {
    const accepted = await request(interjectPath, body)
    expect(accepted.status).toBe(200)
    const identity = await accepted.json()
    expect(await (await request(interjectPath, body)).json()).toEqual(identity)
    const acceptedHistory = (await (await request(`${path}/messages`)).json()) as {
      messages: AgentMessageView[]
    }
    expect(acceptedHistory.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
    ])
    expect(acceptedHistory.messages.at(-1)?.content).toEqual([
      { type: 'text', text: body.text, references: [reference] },
    ])
    first.push('，原回复后半段')
    first.finish()
    await waitFor(async () => !(await (await request(`${path}/messages`)).json()).activeTurn, 5000)
    const history = (await (await request(`${path}/messages`)).json()) as {
      messages: AgentMessageView[]
    }
    expect(history.messages.filter((message) => message.role === 'user')).toHaveLength(2)
    expect(history.messages[1]?.content).toEqual([
      { type: 'text', text: '原回复前半段，原回复后半段' },
    ])
    expect(calls).toHaveLength(2)
    // The response may have been lost after acceptance, even after the turn has ended.
    expect(await (await request(interjectPath, body)).json()).toEqual(identity)
    const { purgeExpiredAttachmentMedia } = await import('../../lib/projectMedia')
    expect(
      await purgeExpiredAttachmentMedia(
        Math.max(original.expiresAt, mask.expiresAt, original.leaseExpiresAt, mask.leaseExpiresAt) +
          60_000,
      ),
    ).toBe(0)
  } finally {
    await request(`${path}/turns/${start.turnId}/abort`, { deviceId })
  }
})

it('keeps historical marks visible while a new request reads the original without an expired selection', async () => {
  const source = await sharp({
    create: { width: 1024, height: 1024, channels: 4, background: '#cc4422' },
  })
    .png()
    .toBuffer()
  const original = await upload(source)
  const mask = await upload(
    await sharp({
      create: { width: 1024, height: 1024, channels: 4, background: '#00000000' },
    })
      .png()
      .toBuffer(),
  )
  setAgentFetchForTesting(recordingAgentFetch([], () => completionStream('本轮标记已看过')))
  const { conversation } = await (await request('agent/conversations', { deviceId })).json()
  const path = `agent/conversations/${conversation.id}`
  await (
    await request(`${path}/turns`, {
      deviceId,
      text: '看看这次选区',
      references: [
        {
          imageId: 'marked-photo',
          mediaId: original.id,
          maskMediaId: mask.id,
          editAction: 'inpaint',
          regions: [{ x: 0, y: 0, width: 1, height: 1 }],
        },
      ],
    })
  ).text()
  const calls: AgentCall[] = []
  setAgentFetchForTesting(
    scriptedAgentFetch(calls, [
      () =>
        toolCallCompletion({
          id: 'read-original',
          name: 'viewImage',
          args: { imageIds: ['marked-photo'] },
        }),
      () => completionStream('描述的是整张原图'),
    ]),
  )
  const next = await request(`${path}/turns`, {
    deviceId,
    text: '现在描述整张原图，不沿用刚才的选区',
  })
  expect(next.status).toBe(200)
  await next.text()
  expect(calls).toHaveLength(2)
  expect(/selection_[a-f0-9]{64}/.test(JSON.stringify(calls[1]!.messages))).toBe(false)
  const history = (await (await request(`${path}/messages`)).json()) as {
    messages: AgentMessageView[]
  }
  const user = history.messages.find((message) => message.role === 'user')!
  const referencePath = `${path}/messages/${user.id}/references/0`
  const annotated = await request(`${referencePath}?variant=annotated`)
  expect(annotated.status).toBe(200)
  const markedPixels = await sharp(Buffer.from(await annotated.arrayBuffer()))
    .raw()
    .toBuffer()
  expect(markedPixels.equals(await sharp(source).raw().toBuffer())).toBe(false)
  expect(
    Buffer.from(await (await request(`${referencePath}?variant=original`)).arrayBuffer()),
  ).toEqual(source)
})

it('rejects mixed inline and media mask identities instead of silently dropping the selection', async () => {
  const source = await sharp({
    create: { width: 1024, height: 1024, channels: 4, background: '#aa7788' },
  })
    .png()
    .toBuffer()
  const original = await upload(source)
  const maskBytes = await sharp({
    create: { width: 1024, height: 1024, channels: 4, background: '#00000000' },
  })
    .png()
    .toBuffer()
  const mask = await upload(maskBytes)
  setAgentFetchForTesting(recordingAgentFetch([], () => completionStream('收到')))
  const { conversation } = await (await request('agent/conversations', { deviceId })).json()
  const path = `agent/conversations/${conversation.id}`
  for (const reference of [
    {
      imageId: 'photo',
      mediaId: original.id,
      maskDataUrl: `data:image/png;base64,${maskBytes.toString('base64')}`,
    },
    {
      imageId: 'photo',
      dataUrl: `data:image/png;base64,${source.toString('base64')}`,
      maskMediaId: mask.id,
    },
  ]) {
    const response = await request(`${path}/turns`, {
      deviceId,
      text: '只修改选区',
      references: [reference],
    })
    const status = response.status
    await response.text()
    expect(status).toBe(422)
  }
  expect((await (await request(`${path}/messages`)).json()).messages).toEqual([])
  const { purgeExpiredAttachmentMedia } = await import('../../lib/projectMedia')
  expect(
    await purgeExpiredAttachmentMedia(
      Math.max(original.expiresAt, mask.expiresAt, original.leaseExpiresAt, mask.leaseExpiresAt) +
        60_000,
    ),
  ).toBe(2)
})
