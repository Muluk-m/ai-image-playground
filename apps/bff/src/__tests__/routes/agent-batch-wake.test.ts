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

process.env.DATABASE_URL = await resetTestDatabase('bff_agent_batch_wake')
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

it('整批跨窗口完成后持久投递一次复核，沿用新轮预算且不改原轮账本', async () => {
  billing.answer = { kind: 'reserved', credits: 7 }
  billing.settledCredits = 7
  const mediaId = await upload('#489517')
  const { conversation } = await (await request('agent/conversations', { deviceId: DEVICE })).json()
  const calls: AgentCall[] = []
  setAgentFetchForTesting(
    scriptedAgentFetch(calls, [
      () =>
        toolCallCompletion({
          id: 'aggregate-batch',
          name: 'planImageBatch',
          args: {
            title: '三项统一复核',
            rule: '分别换底色',
            items: ['one', 'two', 'three'].map((key) => ({
              key,
              imageIds: ['original'],
              prompt: `原图第${key}种底色`,
              dependencies: [],
            })),
          },
        }),
      () => completionStream('请确认三项'),
      () => completionStream('批次已完成，三个任务均成功。'),
    ]),
  )
  await (
    await request(`agent/conversations/${conversation.id}/turns`, {
      deviceId: DEVICE,
      text: '拟三项统一计划',
      references: [{ imageId: 'original', mediaId }],
    })
  ).text()
  await waitFor(async () => {
    const [lease] = await db
      .select()
      .from(schema.agent_executions)
      .where(eq(schema.agent_executions.conversation_id, conversation.id))
    return lease?.state !== 'running'
  })
  const { batches } = await (await request(`agent/conversations/${conversation.id}/batches`)).json()
  expect(batches).toHaveLength(1)
  const path = `agent/batches/${batches[0].id}`
  const draft = await (await request(path)).json()
  const originBefore = await db
    .select()
    .from(schema.agent_model_calls)
    .where(eq(schema.agent_model_calls.turn_id, draft.batch.originTurnId))
  const command = {
    commandId: crypto.randomUUID(),
    expectedVersion: 1,
    expectedDigest: draft.batch.digest,
    deviceId: DEVICE,
  }
  const confirmedResponse = await request(`${path}/confirm`, command)
  expect(confirmedResponse.status).toBe(200)
  const confirmed = await confirmedResponse.json()
  const wakes = () =>
    db
      .select()
      .from(schema.agent_inbox)
      .where(
        and(
          eq(schema.agent_inbox.conversation_id, conversation.id),
          eq(schema.agent_inbox.kind, 'task_result'),
        ),
      )
  const output = await sharp({
    create: { width: 8, height: 6, channels: 4, background: '#ffffff' },
  })
    .png()
    .toBuffer()
  let generationCalls = 0
  setUpstreamFetchForTesting(async () => {
    generationCalls++
    return Response.json({ data: [{ b64_json: output.toString('base64') }] })
  })
  await runTask(confirmed.items[0].execution.taskId)
  await runTask(confirmed.items[1].execution.taskId)
  await request(path)
  expect(await wakes()).toHaveLength(0)
  expect(calls).toHaveLength(2)
  const advanced = await (await request(`${path}/confirm`, command)).json()
  await runTask(advanced.items[2].execution.taskId)
  const restartedWorker = new TaskScheduler()
  try {
    restartedWorker.start()
    await waitFor(() => restartedWorker.lastSuccessfulPollAt() !== null)
    await restartedWorker.waitForIdle(5000)
  } finally {
    restartedWorker.stop()
    await restartedWorker.waitForIdle(5000)
  }
  const completed = await (await request(path)).json()
  expect(completed.batch).toMatchObject({ status: 'closed', submittedCount: 3, actualCredits: 21 })
  const [wake] = await wakes()
  expect(wake).toMatchObject({
    status: 'pending',
    kind: 'task_result',
    payload: {
      batch: {
        batchId: draft.batch.id,
        version: 1,
        eventVersion: 1,
        itemKeys: ['one', 'two', 'three'],
      },
    },
  })
  await request(path)
  await request(`${path}/confirm`, command)
  expect(await wakes()).toHaveLength(1)
  expect(calls).toHaveLength(2)
  expect(await pickUpStrandedInboxes()).toBe(1)
  await waitFor(async () => {
    const turns = await db
      .select()
      .from(schema.agent_turns)
      .where(eq(schema.agent_turns.conversation_id, conversation.id))
    const [lease] = await db
      .select()
      .from(schema.agent_executions)
      .where(eq(schema.agent_executions.conversation_id, conversation.id))
    return turns.length === 2 && lease?.state !== 'running'
  })
  expect(calls).toHaveLength(3)
  expect(generationCalls).toBe(3)
  expect((await wakes())[0]).toMatchObject({ status: 'consumed' })
  expect(await pickUpStrandedInboxes()).toBe(0)
  expect(
    await db
      .select()
      .from(schema.agent_model_calls)
      .where(eq(schema.agent_model_calls.turn_id, draft.batch.originTurnId)),
  ).toEqual(originBefore)
  expect(billing.reservations.filter((one) => one.model === 'fixture-agent-model')).toHaveLength(2)
  expect(billing.reservations.filter((one) => one.model !== 'fixture-agent-model')).toHaveLength(3)
}, 20000)

it('批次聚合通知沿用余额门禁，余额不足不新开模型轮且不会充值后自动重放', async () => {
  billing.answer = { kind: 'reserved', credits: 7 }
  billing.settledCredits = 7
  const mediaId = await upload('#489517')
  const { conversation } = await (await request('agent/conversations', { deviceId: DEVICE })).json()
  const calls: AgentCall[] = []
  setAgentFetchForTesting(
    scriptedAgentFetch(calls, [
      () =>
        toolCallCompletion({
          id: 'aggregate-batch',
          name: 'planImageBatch',
          args: {
            title: '三项统一复核',
            rule: '分别换底色',
            items: ['one', 'two', 'three'].map((key) => ({
              key,
              imageIds: ['original'],
              prompt: `原图第${key}种底色`,
              dependencies: [],
            })),
          },
        }),
      () => completionStream('请确认三项'),
      () => completionStream('批次已完成，三个任务均成功。'),
    ]),
  )
  await (
    await request(`agent/conversations/${conversation.id}/turns`, {
      deviceId: DEVICE,
      text: '拟三项统一计划',
      references: [{ imageId: 'original', mediaId }],
    })
  ).text()
  await waitFor(async () => {
    const [lease] = await db
      .select()
      .from(schema.agent_executions)
      .where(eq(schema.agent_executions.conversation_id, conversation.id))
    return lease?.state !== 'running'
  })
  const { batches } = await (await request(`agent/conversations/${conversation.id}/batches`)).json()
  expect(batches).toHaveLength(1)
  const path = `agent/batches/${batches[0].id}`
  const draft = await (await request(path)).json()
  const command = {
    commandId: crypto.randomUUID(),
    expectedVersion: 1,
    expectedDigest: draft.batch.digest,
    deviceId: DEVICE,
  }
  const confirmedResponse = await request(`${path}/confirm`, command)
  expect(confirmedResponse.status).toBe(200)
  const confirmed = await confirmedResponse.json()
  const wakes = () =>
    db
      .select()
      .from(schema.agent_inbox)
      .where(
        and(
          eq(schema.agent_inbox.conversation_id, conversation.id),
          eq(schema.agent_inbox.kind, 'task_result'),
        ),
      )
  const output = await sharp({
    create: { width: 8, height: 6, channels: 4, background: '#ffffff' },
  })
    .png()
    .toBuffer()
  let generationCalls = 0
  setUpstreamFetchForTesting(async () => {
    generationCalls++
    return Response.json({ data: [{ b64_json: output.toString('base64') }] })
  })
  await runTask(confirmed.items[0].execution.taskId)
  await runTask(confirmed.items[1].execution.taskId)
  await request(path)
  expect(await wakes()).toHaveLength(0)
  expect(calls).toHaveLength(2)
  const advanced = await (await request(`${path}/confirm`, command)).json()
  await runTask(advanced.items[2].execution.taskId)
  const restartedWorker = new TaskScheduler()
  try {
    restartedWorker.start()
    await waitFor(() => restartedWorker.lastSuccessfulPollAt() !== null)
    await restartedWorker.waitForIdle(5000)
  } finally {
    restartedWorker.stop()
    await restartedWorker.waitForIdle(5000)
  }
  const completed = await (await request(path)).json()
  expect(completed.batch).toMatchObject({ status: 'closed', submittedCount: 3, actualCredits: 21 })
  const [wake] = await wakes()
  expect(wake).toMatchObject({
    status: 'pending',
    kind: 'task_result',
    payload: {
      batch: {
        batchId: draft.batch.id,
        version: 1,
        eventVersion: 1,
        itemKeys: ['one', 'two', 'three'],
      },
    },
  })
  billing.answer = { kind: 'insufficient_credits', required: 50, available: 0 }
  expect(await pickUpStrandedInboxes()).toBe(0)
  expect(calls).toHaveLength(2)
  expect((await wakes())[0]).toMatchObject({ status: 'cancelled' })
  expect(generationCalls).toBe(3)
  billing.answer = { kind: 'reserved', credits: 7 }
  expect(await pickUpStrandedInboxes()).toBe(0)
  expect(calls).toHaveLength(2)
  expect((await (await request(path)).json()).batch).toMatchObject({
    status: 'closed',
    actualCredits: 21,
  })
}, 20000)

it('用户新消息合并待处理批次通知，只开用户轮并保留批次确定性摘要', async () => {
  billing.answer = { kind: 'reserved', credits: 7 }
  billing.settledCredits = 7
  const mediaId = await upload('#489517')
  const { conversation } = await (await request('agent/conversations', { deviceId: DEVICE })).json()
  const calls: AgentCall[] = []
  setAgentFetchForTesting(
    scriptedAgentFetch(calls, [
      () =>
        toolCallCompletion({
          id: 'aggregate-batch',
          name: 'planImageBatch',
          args: {
            title: '三项统一复核',
            rule: '分别换底色',
            items: ['one', 'two', 'three'].map((key) => ({
              key,
              imageIds: ['original'],
              prompt: `原图第${key}种底色`,
              dependencies: [],
            })),
          },
        }),
      () => completionStream('请确认三项'),
      () => completionStream('批次已完成，三个任务均成功。'),
    ]),
  )
  await (
    await request(`agent/conversations/${conversation.id}/turns`, {
      deviceId: DEVICE,
      text: '拟三项统一计划',
      references: [{ imageId: 'original', mediaId }],
    })
  ).text()
  await waitFor(async () => {
    const [lease] = await db
      .select()
      .from(schema.agent_executions)
      .where(eq(schema.agent_executions.conversation_id, conversation.id))
    return lease?.state !== 'running'
  })
  const { batches } = await (await request(`agent/conversations/${conversation.id}/batches`)).json()
  expect(batches).toHaveLength(1)
  const path = `agent/batches/${batches[0].id}`
  const draft = await (await request(path)).json()
  const originBefore = await db
    .select()
    .from(schema.agent_model_calls)
    .where(eq(schema.agent_model_calls.turn_id, draft.batch.originTurnId))
  const command = {
    commandId: crypto.randomUUID(),
    expectedVersion: 1,
    expectedDigest: draft.batch.digest,
    deviceId: DEVICE,
  }
  const confirmedResponse = await request(`${path}/confirm`, command)
  expect(confirmedResponse.status).toBe(200)
  const confirmed = await confirmedResponse.json()
  const wakes = () =>
    db
      .select()
      .from(schema.agent_inbox)
      .where(
        and(
          eq(schema.agent_inbox.conversation_id, conversation.id),
          eq(schema.agent_inbox.kind, 'task_result'),
        ),
      )
  const output = await sharp({
    create: { width: 8, height: 6, channels: 4, background: '#ffffff' },
  })
    .png()
    .toBuffer()
  let generationCalls = 0
  setUpstreamFetchForTesting(async () => {
    generationCalls++
    return Response.json({ data: [{ b64_json: output.toString('base64') }] })
  })
  await runTask(confirmed.items[0].execution.taskId)
  await runTask(confirmed.items[1].execution.taskId)
  await request(path)
  expect(await wakes()).toHaveLength(0)
  expect(calls).toHaveLength(2)
  const advanced = await (await request(`${path}/confirm`, command)).json()
  await runTask(advanced.items[2].execution.taskId)
  const restartedWorker = new TaskScheduler()
  try {
    restartedWorker.start()
    await waitFor(() => restartedWorker.lastSuccessfulPollAt() !== null)
    await restartedWorker.waitForIdle(5000)
  } finally {
    restartedWorker.stop()
    await restartedWorker.waitForIdle(5000)
  }
  const completed = await (await request(path)).json()
  expect(completed.batch).toMatchObject({ status: 'closed', submittedCount: 3, actualCredits: 21 })
  const [wake] = await wakes()
  expect(wake).toMatchObject({
    status: 'pending',
    kind: 'task_result',
    payload: {
      batch: {
        batchId: draft.batch.id,
        version: 1,
        eventVersion: 1,
        itemKeys: ['one', 'two', 'three'],
      },
    },
  })
  const response = await request(`agent/conversations/${conversation.id}/turns`, {
    deviceId: DEVICE,
    text: '请简短解释这一批的任务状态，不做视觉复核',
  })
  expect(response.status).toBe(200)
  await response.text()
  await waitFor(async () => {
    const [lease] = await db
      .select()
      .from(schema.agent_executions)
      .where(eq(schema.agent_executions.conversation_id, conversation.id))
    return lease?.state !== 'running'
  })
  expect(calls).toHaveLength(3)
  expect(JSON.stringify(calls[2]!.messages)).toContain('已确认批次的一版执行结果全部确定')
  expect((await wakes())[0]).toMatchObject({ status: 'consumed' })
  expect(await pickUpStrandedInboxes()).toBe(0)
  expect(generationCalls).toBe(3)
  expect(
    await db
      .select()
      .from(schema.agent_model_calls)
      .where(eq(schema.agent_model_calls.turn_id, draft.batch.originTurnId)),
  ).toEqual(originBefore)
  expect(billing.reservations.filter((one) => one.model === 'fixture-agent-model')).toHaveLength(2)
}, 20000)
