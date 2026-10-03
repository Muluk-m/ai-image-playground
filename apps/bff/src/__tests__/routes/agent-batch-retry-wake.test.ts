import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { DEVICE_ID_HEADER } from '@image-playground/shared'
import { and, eq } from 'drizzle-orm'
import sharp from 'sharp'
import {
  type AgentCall,
  completionStream,
  scriptedAgentFetch,
  TEST_IMAGE_CHANNEL,
  toolCallCompletion,
} from '../helpers/agentStubs'
import { silenceChatUpstream } from '../helpers/chatStubs'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { installRecordingTaskHooks } from '../helpers/privateOverlayStub'
import { waitFor } from '../helpers/upstreamStubs'

process.env.DATABASE_URL = await resetTestDatabase('batch_retry_wake_facts')
process.env.PORT = '0'
process.env.INTERNAL_API_TOKEN = 'batch-reconciliation-token'
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
const { pickUpStrandedInboxes } = await import('../../lib/agent/inbox-pickup')
const { runTask } = await import('../../workers/task-runner')
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
    id: 'batch-wake-owner',
    username: 'batch-wake-owner',
    password_hash: 'fixture',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
  cookie = `${USER_SESSION_COOKIE}=${await db.transaction((tx) => createUserSession('batch-wake-owner', tx))}`
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

it('retry v2 wakes with the approved second attempt success and its own charge', async () => {
  billing.answer = { kind: 'reserved', credits: 7 }
  billing.settledCredits = 7
  const mediaId = await upload('#485719')
  const { conversation } = await (await request('agent/conversations', { deviceId: DEVICE })).json()
  const calls: AgentCall[] = []
  setAgentFetchForTesting(
    scriptedAgentFetch(calls, [
      () =>
        toolCallCompletion({
          id: 'retry-wake-plan',
          name: 'planImageBatch',
          args: {
            title: 'one item then explicit retry',
            rule: 'white background',
            items: [
              {
                key: 'first',
                imageIds: ['original'],
                prompt: 'change original to white background',
                dependencies: [],
              },
            ],
          },
        }),
      () => completionStream('请确认这项。'),
      () => completionStream('第一版有一个明确失败。'),
      () => completionStream('第二版重试成功，实际消耗11积分。'),
    ]),
  )
  const turn = await request(`agent/conversations/${conversation.id}/turns`, {
    deviceId: DEVICE,
    text: '拟一项白底计划',
    references: [{ imageId: 'original', mediaId }],
  })
  expect(turn.status).toBe(200)
  await turn.text()
  const settled = async () => {
    const [execution] = await db
      .select({ state: schema.agent_executions.state })
      .from(schema.agent_executions)
      .where(eq(schema.agent_executions.conversation_id, conversation.id))
    return execution?.state !== 'running'
  }
  await waitFor(settled)
  const { batches } = await (await request(`agent/conversations/${conversation.id}/batches`)).json()
  const path = `agent/batches/${batches[0].id}`
  const draft = await (await request(path)).json()
  const confirmed = await (
    await request(`${path}/confirm`, {
      commandId: 'confirm-first',
      expectedVersion: 1,
      expectedDigest: draft.batch.digest,
      deviceId: DEVICE,
    })
  ).json()
  const firstTask = confirmed.items[0].execution.taskId
  let generationCalls = 0
  setUpstreamFetchForTesting(async () => {
    generationCalls++
    return Response.json(
      { error: { code: 'invalid_image', message: 'Invalid image' } },
      { status: 400 },
    )
  })
  await runTask(firstTask)
  const { reconcileAgentBatchProgress } = await import('../../lib/agent/batch-progress')
  await reconcileAgentBatchProgress(batches[0].id)
  expect(await pickUpStrandedInboxes()).toBe(1)
  await waitFor(async () => calls.length === 3 && (await settled()))
  imageUnitCredits = 11
  const retry = await request(`${path}/retry-quote`, {
    commandId: 'quote-second-attempt',
    expectedVersion: 1,
    itemKeys: ['first'],
  })
  expect(retry.status).toBe(200)
  const quoted = await retry.json()
  expect(quoted.batch).toMatchObject({
    version: 2,
    estimate: { generation: { estimatedChargeCredits: 11 } },
  })
  const [plan] = await db
    .select({ targets: schema.agent_batch_plans.attempt_targets })
    .from(schema.agent_batch_plans)
    .where(
      and(
        eq(schema.agent_batch_plans.batch_id, batches[0].id),
        eq(schema.agent_batch_plans.version, 2),
      ),
    )
  expect(plan?.targets).toEqual({ first: 2 })
  billing.answer = { kind: 'reserved', credits: 11 }
  billing.settledCredits = 11
  const accepted = await request(`${path}/confirm`, {
    commandId: 'confirm-second-attempt',
    expectedVersion: 2,
    expectedDigest: quoted.batch.digest,
    deviceId: DEVICE,
  })
  expect(accepted.status).toBe(200)
  const [second] = await db
    .select({ id: schema.agent_batch_attempts.task_id })
    .from(schema.agent_batch_attempts)
    .where(
      and(
        eq(schema.agent_batch_attempts.batch_id, batches[0].id),
        eq(schema.agent_batch_attempts.item_key, 'first'),
        eq(schema.agent_batch_attempts.attempt, 2),
      ),
    )
  if (!second) throw new Error('retry task was not reserved')
  expect(second.id).not.toBe(firstTask)
  const output = await sharp({
    create: { width: 8, height: 6, channels: 4, background: '#ffffff' },
  })
    .png()
    .toBuffer()
  setUpstreamFetchForTesting(async () => {
    generationCalls++
    return Response.json({ data: [{ b64_json: output.toString('base64') }] })
  })
  await runTask(second.id)
  await reconcileAgentBatchProgress(batches[0].id)
  const notices = await db
    .select()
    .from(schema.agent_inbox)
    .where(
      and(
        eq(schema.agent_inbox.conversation_id, conversation.id),
        eq(schema.agent_inbox.kind, 'task_result'),
      ),
    )
  const wake = notices.find(
    (notice) =>
      notice.kind === 'task_result' &&
      'batch' in notice.payload &&
      notice.payload.batch?.version === 2,
  )
  expect(wake).toBeDefined()
  if (!wake || wake.kind !== 'task_result' || !('batch' in wake.payload) || !wake.payload.batch)
    throw new Error('retry wake missing')
  const { batchWakeSummary } = await import('../../lib/agent/batch-wake')
  const summary = await batchWakeSummary(
    conversation.id,
    { kind: 'user', userId: 'batch-wake-owner' },
    wake.payload.batch,
  )
  if (!summary) throw new Error('retry wake facts missing')
  const facts = JSON.parse(summary.split('\n').find((line) => line.startsWith('[{'))!)
  expect({ taskIds: wake.payload.taskIds, facts }).toEqual({
    taskIds: [second.id],
    facts: [{ itemKey: 'first', attempt: 2, status: 'completed', actualCredits: 11 }],
  })
  expect(await pickUpStrandedInboxes()).toBe(1)
  await waitFor(async () => calls.length === 4 && (await settled()))
  function textOf(content: unknown): string {
    if (typeof content === 'string') return content
    if (Array.isArray(content)) return content.map(textOf).join('\n')
    if (
      content &&
      typeof content === 'object' &&
      'text' in content &&
      typeof content.text === 'string'
    )
      return content.text
    return ''
  }
  const sentFacts = calls[3]!.messages.map((message) => textOf(message.content)).join('\n')
  expect(sentFacts).toContain('"attempt":2,"status":"completed","actualCredits":11')
  expect(generationCalls).toBe(2)
  expect(billing.reservations.filter((one) => one.model !== 'fixture-agent-model')).toHaveLength(2)
  expect(await pickUpStrandedInboxes()).toBe(0)
}, 20000)
