import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { DEVICE_ID_HEADER } from '@image-playground/shared'
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

process.env.DATABASE_URL = await resetTestDatabase('bff_task_scheduler_batch')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.OPERATOR_CONFIG_FILE = resolve(
  import.meta.dir,
  '../batch-execution-operator-config.json',
)
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
const { config } = await import('../../config')
const { runTask } = await import('../../workers/task-runner')
const { TaskScheduler } = await import('../../workers/task-scheduler')
const { setUpstreamFetchForTesting } = await import('../../lib/upstream')
const { setAgentFetchForTesting } = await import('../../lib/agent/model')
const { _setChannelsForTesting } = await import('../../lib/channels')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { setDurableMediaStoreForTesting } = await import('../../lib/durableMediaStore')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
const { db, schema, close } = await import('../../db/client')
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
    id: 'scheduler-batch-owner',
    username: 'scheduler-batch-owner',
    password_hash: 'fixture',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
  cookie = `${USER_SESSION_COOKIE}=${await db.transaction((tx) => createUserSession('scheduler-batch-owner', tx))}`
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

async function upload(background: string | Buffer) {
  const bytes =
    typeof background === 'string'
      ? await sharp({ create: { width: 8, height: 6, channels: 4, background } })
          .png()
          .toBuffer()
      : background
  const response = await request('media/uploads', {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    contentType: 'image/png',
    purpose: 'conversation-attachment',
  })
  expect(response.status).toBe(200)
  const media = await response.json()
  if (media.status !== 'ready') {
    await storage.write(new URL(media.uploadUrl).pathname.slice(1), bytes, 'image/png')
    expect((await request(`media/${media.id}/complete`, {})).status).toBe(200)
  }
  return media.id as string
}

it('slow batch media preparation does not block ordinary launches, cancellation polls, or a safe drain', async () => {
  billing.answer = { kind: 'reserved', credits: 7 }
  billing.settledCredits = 7
  const mediaId = await upload('#abcdef')
  const { conversation } = await (await request('agent/conversations', { deviceId: DEVICE })).json()
  setAgentFetchForTesting(
    scriptedAgentFetch(
      [],
      [
        () =>
          toolCallCompletion({
            id: 'scheduler-batch',
            name: 'planImageBatch',
            args: {
              title: '慢读取仍可调度',
              rule: '分别生成',
              items: [
                { key: 'first', imageIds: ['original'], prompt: '白背景', dependencies: [] },
                { key: 'second', imageIds: ['original'], prompt: '蓝背景', dependencies: [] },
                { key: 'third', imageIds: ['original'], prompt: '绿背景', dependencies: [] },
              ],
            },
          }),
        () => completionStream('请确认'),
      ],
    ),
  )
  await (
    await request(`agent/conversations/${conversation.id}/turns`, {
      deviceId: DEVICE,
      text: '分别生成三种背景',
      references: [{ imageId: 'original', mediaId }],
    })
  ).text()
  const { batches } = await (await request(`agent/conversations/${conversation.id}/batches`)).json()
  expect(batches).toHaveLength(1)
  const path = `agent/batches/${batches[0].id}`
  const draft = await (await request(path)).json()
  const accepted = await (
    await request(`${path}/confirm`, {
      commandId: 'confirm-scheduler',
      expectedVersion: 1,
      expectedDigest: draft.batch.digest,
      deviceId: DEVICE,
    })
  ).json()
  expect(accepted.batch.submittedCount).toBe(2)
  const output = await sharp({
    create: { width: 8, height: 6, channels: 4, background: '#ffffff' },
  })
    .png()
    .toBuffer()
  setUpstreamFetchForTesting(async () =>
    Response.json({ data: [{ b64_json: output.toString('base64') }] }),
  )
  for (const item of accepted.items.slice(0, 2)) await runTask(item.execution.taskId)

  const queued = await request(
    `v1/queue/openai-compat/${TEST_IMAGE_CHANNEL.models[0]!.id}/submit`,
    { prompt: 'ordinary request', device_id: DEVICE },
  )
  expect(queued.status).toBe(200)
  const { request_id: ordinaryId } = await queued.json()
  let normalStarted = false
  let normalAborted = false
  setUpstreamFetchForTesting(async (_input, init) => {
    normalStarted = true
    return await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      const abort = () => {
        normalAborted = true
        reject(new DOMException('Aborted', 'AbortError'))
      }
      if (signal?.aborted) abort()
      else signal?.addEventListener('abort', abort, { once: true })
    })
  })
  let release!: () => void
  let reads = 0
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  storage.beforeRead = async () => {
    reads++
    await barrier
  }
  const worker = new TaskScheduler({ pollIntervalMs: 10_000, concurrency: { 'openai-compat': 1 } })
  try {
    worker.start()
    await waitFor(() => reads > 0)
    // A real object-store read is stalled, but the unrelated queued request must already start.
    await waitFor(() => normalStarted)
    expect(normalStarted).toBe(true)
    expect((await request(`v1/queue/requests/${ordinaryId}/cancel`, {}, 'PUT')).status).toBe(200)
    await worker.tick()
    await waitFor(() => normalAborted && worker.activeCount() === 0)
    await worker.tick()
    await worker.tick()
    expect(reads).toBe(1) // More polling does not start another copy of the stalled batch.
    worker.drain()
    await worker.tick()
    expect(worker.drainStatus()).toMatchObject({ draining: true, active: 0, safeToStop: false })
    expect(await worker.waitForIdle(20)).toBe(false)
    worker.stop()
    release()
    expect(await worker.waitForIdle(5000)).toBe(true)
    expect(worker.drainStatus().safeToStop).toBe(true)
    expect((await (await request(path)).json()).batch.submittedCount).toBe(2)
  } finally {
    worker.stop()
    release()
    storage.beforeRead = undefined
    await worker.waitForIdle(5000)
  }
}, 15_000)
