import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { DEVICE_ID_HEADER } from '@image-playground/shared'
import { eq } from 'drizzle-orm'
import sharp from 'sharp'
import {
  completionStream,
  scriptedAgentFetch,
  TEST_IMAGE_CHANNEL,
  toolCallCompletion,
} from '../helpers/agentStubs'
import { silenceChatUpstream } from '../helpers/chatStubs'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { installRecordingTaskHooks } from '../helpers/privateOverlayStub'
import { waitFor } from '../helpers/upstreamStubs'

process.env.DATABASE_URL = await resetTestDatabase('bff_agent_batch_item_cancel')
process.env.PORT = '0'
process.env.WORKER_OPENAI_CONCURRENCY = '3'
process.env.INTERNAL_API_TOKEN = 'batch-reconciliation-token'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../t13-batch-100-operator-config.json')
let imageUnitCredits = 7
const billing = installRecordingTaskHooks()
const { loadPrivateBffOverlay, _setPrivateBffOverlayForTesting } = await import(
  '../../lib/private-overlay'
)
const overlay = await loadPrivateBffOverlay()
_setPrivateBffOverlayForTesting({
  ...overlay,
  taskHooks: {
    ...overlay.taskHooks,
    async quoteTask({ model, quantity, unitMultiplier }) {
      return {
        estimatedCredits: imageUnitCredits * quantity * unitMultiplier,
        pricing: {
          model,
          unit: 'image',
          quantity,
          unitMultiplier,
          baseUnitCredits: imageUnitCredits,
          pricingVersion: `price-${imageUnitCredits}`,
          quotedAt: 1000,
          validUntil: null,
          outputPriceRatio: 0,
          cachedInputPriceRatio: 0,
          inputEstimateTokens: 0,
          outputReserveTokens: 0,
          exemption: 'none',
        },
      }
    },
  },
})
const { app } = await import('../../app')
const { setUpstreamFetchForTesting } = await import('../../lib/upstream')
const { setAgentFetchForTesting } = await import('../../lib/agent/model')
const { _setChannelsForTesting } = await import('../../lib/channels')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { setDurableMediaStoreForTesting } = await import('../../lib/durableMediaStore')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
const { db, schema, close } = await import('../../db/client')
const { config } = await import('../../config')
await silenceChatUpstream()

class MediaStorage extends InMemoryObjectStore {
  beforeRead?: (key: string) => Promise<void>
  advertisedSize?: number
  override async open(key: string) {
    await this.beforeRead?.(key)
    const object = await super.open(key)
    return { ...object, size: this.advertisedSize ?? object.size }
  }
  override async read(key: string) {
    await this.beforeRead?.(key)
    return super.read(key)
  }
  sign(key: string, method: 'GET' | 'PUT') {
    return `https://storage.example.test/${key}?method=${method}`
  }
}
const storage = new MediaStorage()
const DEVICE = 'batch-execution-device'
let cookie = ''

beforeAll(async () => {
  const now = Date.now()
  await db.insert(schema.users).values({
    id: 'batch-cancel-owner',
    username: 'batch-cancel-owner',
    password_hash: 'fixture',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
  cookie = `${USER_SESSION_COOKIE}=${await db.transaction((tx) => createUserSession('batch-cancel-owner', tx))}`
  setDurableMediaStoreForTesting(storage)
  setObjectStoreForTesting(new InMemoryObjectStore())
  _setChannelsForTesting([TEST_IMAGE_CHANNEL])
})
beforeEach(() => billing.reset())
afterEach(() => {
  imageUnitCredits = 7
  setAgentFetchForTesting()
  setUpstreamFetchForTesting()
})
afterAll(close)

function request(
  path: string,
  body?: unknown,
  method = body ? 'POST' : 'GET',
  requestCookie = cookie,
) {
  return app.handle(
    new Request(`http://localhost${path.startsWith('v1/') ? '/' : '/api/'}${path}`, {
      method,
      headers: {
        cookie: requestCookie,
        'content-type': 'application/json',
        [DEVICE_ID_HEADER]: DEVICE,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  )
}

async function upload(background: string | Buffer, requestCookie = cookie) {
  const bytes =
    typeof background === 'string'
      ? await sharp({ create: { width: 8, height: 6, channels: 4, background } })
          .png()
          .toBuffer()
      : background
  const response = await request(
    'media/uploads',
    {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      contentType: 'image/png',
      purpose: 'conversation-attachment',
    },
    'POST',
    requestCookie,
  )
  expect(response.status).toBe(200)
  const media = await response.json()
  if (media.status !== 'ready') {
    await storage.write(new URL(media.uploadUrl).pathname.slice(1), bytes, 'image/png')
    expect((await request(`media/${media.id}/complete`, {}, 'POST', requestCookie)).status).toBe(
      200,
    )
  }
  return media.id as string
}

it('排队中单独取消一张：只撤这一张、走原有取消结算，其余照常，重复点与越权都安全', async () => {
  billing.answer = { kind: 'reserved', credits: 7 }
  const mediaId = await upload('#123456')
  const { conversation } = await (
    await request('agent/conversations', { deviceId: DEVICE }, 'POST')
  ).json()
  setAgentFetchForTesting(
    scriptedAgentFetch(
      [],
      [
        () =>
          toolCallCompletion({
            id: 'plan-cancel',
            name: 'planImageBatch',
            args: {
              title: '三张',
              rule: '三项独立编辑',
              items: [0, 1, 2].map((number) => ({
                key: `item-${number}`,
                imageIds: ['original'],
                prompt: `编号:${number} 背景改白`,
                dependencies: [],
              })),
            },
          }),
        () => completionStream('请确认三项'),
      ],
    ),
  )
  const planned = await request(`agent/conversations/${conversation.id}/turns`, {
    deviceId: DEVICE,
    text: '拟三个独立编辑计划',
    references: [{ imageId: 'original', mediaId }],
  })
  expect(planned.status).toBe(200)
  await planned.text()
  await waitFor(async () => {
    const [lease] = await db
      .select()
      .from(schema.agent_executions)
      .where(eq(schema.agent_executions.conversation_id, conversation.id))
    return lease?.state !== 'running'
  })
  const listed = await (await request(`agent/conversations/${conversation.id}/batches`)).json()
  const path = `agent/batches/${listed.batches[0].id}`
  const draft = await (await request(path)).json()
  const confirmed = await (
    await request(`${path}/confirm`, {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      expectedDigest: draft.batch.digest,
      deviceId: DEVICE,
    })
  ).json()
  expect(confirmed.batch.submittedCount).toBe(3)
  const taskOf = new Map<string, string>(
    confirmed.items.map((item: { key: string; execution: { taskId: string } }) => [
      item.key,
      item.execution.taskId,
    ]),
  )
  billing.reset()

  // 别人的账号点不动这一批。
  const now = Date.now()
  await db.insert(schema.users).values({
    id: 'batch-cancel-stranger',
    username: 'batch-cancel-stranger',
    password_hash: 'fixture',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
  const stranger = `${USER_SESSION_COOKIE}=${await db.transaction((tx) => createUserSession('batch-cancel-stranger', tx))}`
  // 能力默认关：接口整条拒绝，什么都不撤、不结算。
  const closed = await request(`${path}/items/item-1/cancel`, {})
  expect(closed.status).toBe(404)
  expect(await closed.json()).toEqual({
    error: 'capability_unavailable',
    capability: 'agent:batch-item-cancel',
  })
  expect(billing.settlements).toHaveLength(0)
  const operator = config.operator
  config.operator = {
    ...operator,
    capabilities: { ...operator.capabilities, 'agent:batch-item-cancel': true },
  }
  expect((await request(`${path}/items/item-1/cancel`, {}, 'POST', stranger)).status).toBe(404)
  expect(billing.settlements).toHaveLength(0)

  const response = await request(`${path}/items/item-1/cancel`, {})
  expect(response.status).toBe(200)
  const after = await response.json()
  const progress = Object.fromEntries(
    after.items.map((item: { key: string; progress: string }) => [item.key, item.progress]),
  )
  expect(progress).toEqual({ 'item-0': 'in_flight', 'item-1': 'cancelled', 'item-2': 'in_flight' })
  const rows = await db
    .select({ id: schema.tasks.id, status: schema.tasks.status })
    .from(schema.tasks)
    .where(eq(schema.tasks.kind, 'queue'))
  const statusOf = new Map(rows.map((row) => [row.id, row.status]))
  expect(statusOf.get(taskOf.get('item-1')!)).toBe('cancelled')
  expect(statusOf.get(taskOf.get('item-0')!)).toBe('queued')
  expect(statusOf.get(taskOf.get('item-2')!)).toBe('queued')
  // 结算只走原有的取消钩子，且只结这一张。
  expect(billing.settlements).toEqual([
    expect.objectContaining({ taskId: taskOf.get('item-1'), outcome: 'cancelled' }),
  ])

  // 重复点、已结束的项：不报错，也不会再结算一次。
  expect((await request(`${path}/items/item-1/cancel`, {})).status).toBe(200)
  expect((await request(`${path}/items/missing/cancel`, {})).status).toBe(200)
  expect(billing.settlements).toHaveLength(1)

  // 已经认领开跑的不撤：可能已发给上游，撤了也照样出图计费。
  await db
    .update(schema.tasks)
    .set({ status: 'in_progress', started_at: Date.now() })
    .where(eq(schema.tasks.id, taskOf.get('item-0')!))
  expect((await request(`${path}/items/item-0/cancel`, {})).status).toBe(200)
  const [started] = await db
    .select({ status: schema.tasks.status })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskOf.get('item-0')!))
  expect(started?.status).toBe('in_progress')
  expect(billing.settlements).toHaveLength(1)
  config.operator = operator
}, 60000)
