import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { DEVICE_ID_HEADER } from '@image-playground/shared'
import { eq, sql } from 'drizzle-orm'
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

process.env.DATABASE_URL = await resetTestDatabase('bff_agent_batch_execution')
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
const { config } = await import('../../config')
const { runTask } = await import('../../workers/task-runner')
const { TaskScheduler } = await import('../../workers/task-scheduler')
const { purgeOldTasks } = await import('../../db/maintenance')
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
    id: 'batch-execution-owner',
    username: 'batch-execution-owner',
    password_hash: 'fixture',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
  cookie = `${USER_SESSION_COOKIE}=${await db.transaction((tx) => createUserSession('batch-execution-owner', tx))}`
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

it('worker 重启后按持久批次接续提交窗口，三项各执行一次且无需重新确认', async () => {
  billing.reset()
  billing.answer = { kind: 'reserved', credits: 7 }
  billing.settledCredits = 7
  const mediaId = await upload('#aabbcc')
  const { conversation } = await (await request('agent/conversations', { deviceId: DEVICE })).json()
  setAgentFetchForTesting(
    scriptedAgentFetch(
      [],
      [
        () =>
          toolCallCompletion({
            id: 'restart-batch',
            name: 'planImageBatch',
            args: {
              title: '重启后继续的三项',
              rule: '分别生成不同背景',
              items: [
                {
                  key: 'one',
                  imageIds: ['original'],
                  prompt: '原图换成白色背景',
                  dependencies: [],
                },
                {
                  key: 'two',
                  imageIds: ['original'],
                  prompt: '原图换成蓝色背景',
                  dependencies: [],
                },
                {
                  key: 'three',
                  imageIds: ['original'],
                  prompt: '原图换成绿色背景',
                  dependencies: [],
                },
              ],
            },
          }),
        () => completionStream('请确认三项计划'),
      ],
    ),
  )
  await (
    await request(`agent/conversations/${conversation.id}/turns`, {
      deviceId: DEVICE,
      text: '同一原图各生成白蓝绿三种背景，先拟计划',
      references: [{ imageId: 'original', mediaId }],
    })
  ).text()
  const { batches } = await (await request(`agent/conversations/${conversation.id}/batches`)).json()
  expect(batches).toHaveLength(1)
  const path = `agent/batches/${batches[0].id}`
  const draft = await (await request(path)).json()
  const confirmed = await request(`${path}/confirm`, {
    commandId: 'confirm-restart',
    expectedVersion: 1,
    expectedDigest: draft.batch.digest,
    deviceId: DEVICE,
  })
  expect(confirmed.status).toBe(200)
  const accepted = await confirmed.json()
  expect(accepted.batch.submittedCount).toBe(2)
  const initialIds = accepted.items
    .slice(0, 2)
    .map((item: { execution: { taskId: string } }) => item.execution.taskId)
  const calls: string[] = []
  const output = await sharp({
    create: { width: 8, height: 6, channels: 4, background: '#ffffff' },
  })
    .png()
    .toBuffer()
  setUpstreamFetchForTesting(async (_input, init) => {
    calls.push(String((init!.body as FormData).get('prompt')))
    return Response.json({ data: [{ b64_json: output.toString('base64') }] })
  })
  const previousWorker = new TaskScheduler({ pollIntervalMs: 10_000 })
  previousWorker.drain()
  previousWorker.start()
  await waitFor(() => previousWorker.lastSuccessfulPollAt() !== null)
  previousWorker.stop()
  expect(calls).toHaveLength(0)
  const worker = new TaskScheduler({ pollIntervalMs: 10, concurrency: { 'openai-compat': 1 } })
  try {
    worker.start()
    // Only the worker can refill the window; do not read or re-confirm the batch to drive it.
    await waitFor(() => calls.length === 3, 5000)
    await waitFor(async () => (await (await request(path)).json()).batch.status === 'closed', 5000)
    const restored = await (await request(path)).json()
    expect(restored.batch).toMatchObject({ submittedCount: 3, actualCredits: 21 })
    expect(
      restored.items.map((item: { execution: { status: string } }) => item.execution.status),
    ).toEqual(['completed', 'completed', 'completed'])
    expect(
      restored.items
        .slice(0, 2)
        .map((item: { execution: { taskId: string } }) => item.execution.taskId),
    ).toEqual(initialIds)
    expect(new Set(calls).size).toBe(3)
    expect(billing.reservations.filter((one) => one.model !== 'fixture-agent-model')).toHaveLength(
      3,
    )
  } finally {
    previousWorker.stop()
    worker.stop()
    await worker.waitForIdle(5000)
  }
}, 15000)

it('上游鉴权公共故障暂停后续派发，已提交项继续结算且刷新保留失败原因', async () => {
  billing.answer = { kind: 'reserved', credits: 7 }
  billing.settledCredits = 7
  const mediaId = await upload('#887766')
  const { conversation } = await (await request('agent/conversations', { deviceId: DEVICE })).json()
  setAgentFetchForTesting(
    scriptedAgentFetch(
      [],
      [
        () =>
          toolCallCompletion({
            id: 'auth-batch',
            name: 'planImageBatch',
            args: {
              title: '公共故障暂停',
              rule: '分别换成不同背景',
              items: [
                {
                  key: 'auth',
                  imageIds: ['original'],
                  prompt: '原图换成白色背景',
                  dependencies: [],
                },
                {
                  key: 'accepted',
                  imageIds: ['original'],
                  prompt: '原图换成蓝色背景',
                  dependencies: [],
                },
                {
                  key: 'pending',
                  imageIds: ['original'],
                  prompt: '原图换成绿色背景',
                  dependencies: [],
                },
              ],
            },
          }),
        () => completionStream('请确认三项计划'),
      ],
    ),
  )
  await (
    await request(`agent/conversations/${conversation.id}/turns`, {
      deviceId: DEVICE,
      text: '分别换成白蓝绿背景，先拟计划',
      references: [{ imageId: 'original', mediaId }],
    })
  ).text()
  const { batches } = await (await request(`agent/conversations/${conversation.id}/batches`)).json()
  expect(batches).toHaveLength(1)
  const path = `agent/batches/${batches[0].id}`
  const draft = await (await request(path)).json()
  const accepted = await request(`${path}/confirm`, {
    commandId: 'confirm-auth',
    expectedVersion: 1,
    expectedDigest: draft.batch.digest,
    deviceId: DEVICE,
  })
  expect(accepted.status).toBe(200)
  expect((await accepted.json()).batch.submittedCount).toBe(2)
  const output = await sharp({
    create: { width: 8, height: 6, channels: 4, background: '#ffffff' },
  })
    .png()
    .toBuffer()
  let calls = 0
  setUpstreamFetchForTesting(async () => {
    calls++
    return calls === 1
      ? Response.json(
          { error: { message: 'Invalid API key', code: 'invalid_api_key' } },
          { status: 401 },
        )
      : Response.json({ data: [{ b64_json: output.toString('base64') }] })
  })
  const worker = new TaskScheduler({ pollIntervalMs: 10, concurrency: { 'openai-compat': 1 } })
  try {
    worker.start()
    await waitFor(async () => {
      const page = await (await request(path)).json()
      return page.batch.status !== 'running' && page.items[1].execution?.status === 'completed'
    }, 5000)
    const stopped = await (await request(path)).json()
    expect(stopped.batch).toMatchObject({
      status: 'paused',
      pauseReason: 'upstream_auth',
      submittedCount: 2,
      actualCredits: 7,
    })
    expect(stopped.items[0].execution).toMatchObject({ status: 'failed', actualCredits: 0 })
    expect(stopped.items[1].execution).toMatchObject({ status: 'completed', actualCredits: 7 })
    expect(stopped.items[2].execution).toBeUndefined()
    expect(calls).toBe(2)
    expect(billing.reservations.filter((one) => one.model !== 'fixture-agent-model')).toHaveLength(
      2,
    )
  } finally {
    worker.stop()
    await worker.waitForIdle(5000)
  }
}, 15000)

it('删除会话与后续项准备并发时解除批次关联，保留未知任务及必要输入且不再提交', async () => {
  billing.answer = { kind: 'reserved', credits: 7 }
  const first = await upload('#8899aa')
  const second = await upload('#aabb88')
  const { conversation } = await (await request('agent/conversations', { deviceId: DEVICE })).json()
  setAgentFetchForTesting(
    scriptedAgentFetch(
      [],
      [
        () =>
          toolCallCompletion({
            id: 'delete-batch',
            name: 'planImageBatch',
            args: {
              title: '删除时保留核查责任',
              rule: '各自换白底',
              items: [
                { key: 'first', imageIds: ['first'], prompt: '第一张换白底', dependencies: [] },
                { key: 'second', imageIds: ['second'], prompt: '第二张换白底', dependencies: [] },
              ],
            },
          }),
        () => completionStream('请确认完整计划'),
      ],
    ),
  )
  await (
    await request(`agent/conversations/${conversation.id}/turns`, {
      deviceId: DEVICE,
      text: '先拟两张图的计划',
      references: [
        { imageId: 'first', mediaId: first },
        { imageId: 'second', mediaId: second },
      ],
    })
  ).text()
  const { batches } = await (await request(`agent/conversations/${conversation.id}/batches`)).json()
  const batchId = batches[0].id
  const path = `agent/batches/${batchId}`
  const draft = await (await request(path)).json()
  let release!: () => void
  let preparing!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const secondPreparing = new Promise<void>((resolve) => {
    preparing = resolve
  })
  let reads = 0
  storage.beforeRead = async () => {
    if (++reads === 2) {
      preparing()
      await blocked
    }
  }
  const confirming = request(`${path}/confirm`, {
    commandId: 'confirm-deleted',
    expectedVersion: 1,
    expectedDigest: draft.batch.digest,
    deviceId: DEVICE,
  })
  let taskId = ''
  let dispatches = 0
  try {
    await secondPreparing
    const accepted = await (await request(path)).json()
    expect(accepted.batch.submittedCount).toBe(1)
    taskId = accepted.items[0].execution.taskId
    setUpstreamFetchForTesting(async () => {
      dispatches++
      throw new Error('connection lost after upstream acceptance')
    })
    await runTask(taskId)
    expect(await (await request(`v1/queue/requests/${taskId}/status`)).json()).toMatchObject({
      status: 'reconciling',
    })
    expect(
      (await request(`agent/conversations/${conversation.id}`, { deviceId: DEVICE }, 'DELETE'))
        .status,
    ).toBe(200)
  } finally {
    storage.beforeRead = undefined
    release()
    await confirming
  }
  expect((await request(path)).status).toBe(404)
  const [detached] = await db
    .select()
    .from(schema.agent_batches)
    .where(eq(schema.agent_batches.id, batchId))
  expect(detached).toMatchObject({ conversation_id: null, status: 'paused', confirmed_version: 1 })
  expect(detached!.dispatch_generation).toBeGreaterThan(1)
  const attempts = await db
    .select()
    .from(schema.agent_batch_attempts)
    .where(eq(schema.agent_batch_attempts.batch_id, batchId))
  expect(attempts).toHaveLength(1)
  expect(attempts[0]).toMatchObject({
    task_id: taskId,
    reserved_credits: 7,
    price_snapshot: { pricingVersion: 'price-7' },
    terminal_snapshot: null,
  })
  const references = await db
    .select()
    .from(schema.media_references)
    .where(eq(schema.media_references.owner_id, batchId))
  expect(references.map((reference) => reference.media_id).sort()).toEqual([first, second].sort())
  await purgeOldTasks(-1)
  await runTask(taskId)
  expect(await (await request(`v1/queue/requests/${taskId}/status`)).json()).toMatchObject({
    status: 'reconciling',
  })
  expect(dispatches).toBe(1)
  expect(billing.settlements.filter((one) => one.taskId === taskId)).toHaveLength(0)
  expect(billing.reservations.filter((one) => one.model !== 'fixture-agent-model')).toHaveLength(1)
  const reconcile = () =>
    app.handle(
      new Request(`http://localhost/internal/admin/tasks/${taskId}/reconciliation`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer batch-reconciliation-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          commandId: 'deleted-batch-no-result',
          operatorId: 'fixture-operator',
          action: 'confirm_no_result',
          evidence: 'Provider confirmed no generation after connection loss.',
        }),
      }),
    )
  expect((await reconcile()).status).toBe(200)
  expect((await reconcile()).status).toBe(200)
  await purgeOldTasks(-1)
  const [settled] = await db
    .select()
    .from(schema.agent_batches)
    .where(eq(schema.agent_batches.id, batchId))
  expect(settled).toMatchObject({ conversation_id: null, status: 'closed' })
  expect(
    await db
      .select()
      .from(schema.media_references)
      .where(eq(schema.media_references.owner_id, batchId)),
  ).toEqual([])
  const plans = await db
    .select()
    .from(schema.agent_batch_plans)
    .where(eq(schema.agent_batch_plans.batch_id, batchId))
  expect(plans.every((plan) => plan.title === '' && plan.rule === '')).toBe(true)
  const items = await db
    .select()
    .from(schema.agent_batch_items)
    .where(eq(schema.agent_batch_items.batch_id, batchId))
  expect(items.every((item) => item.prompt === '' && item.inputs.length === 0)).toBe(true)
  const [audit] = await db
    .select()
    .from(schema.agent_batch_attempts)
    .where(eq(schema.agent_batch_attempts.batch_id, batchId))
  expect(audit).toMatchObject({
    task_id: taskId,
    reserved_credits: 7,
    price_snapshot: { pricingVersion: 'price-7' },
    terminal_snapshot: { status: 'failed', actualCredits: 0 },
  })
  expect(billing.settlements.filter((one) => one.taskId === taskId)).toHaveLength(1)
  expect(dispatches).toBe(1)
}, 15000)

it('重复确认两图计划只提交两项，重读后 worker 从队列执行并逐项恢复结果和费用', async () => {
  billing.answer = { kind: 'reserved', credits: 7 }
  billing.settledCredits = 7
  const first = await upload('#123456')
  const second = await upload('#abcdef')
  const { conversation } = await (await request('agent/conversations', { deviceId: DEVICE })).json()
  setAgentFetchForTesting(
    scriptedAgentFetch(
      [],
      [
        () =>
          toolCallCompletion({
            id: 'batch-confirm',
            name: 'planImageBatch',
            args: {
              title: '两张白底图',
              rule: '分别换白底',
              items: [
                {
                  key: 'first',
                  imageIds: ['first'],
                  prompt: '第一张保持红色包装并换白底',
                  dependencies: [],
                },
                {
                  key: 'second',
                  imageIds: ['second'],
                  prompt: '第二张保持蓝色包装并换白底',
                  dependencies: [],
                },
              ],
            },
          }),
        () => completionStream('请确认完整计划'),
      ],
    ),
  )
  const turn = await request(`agent/conversations/${conversation.id}/turns`, {
    deviceId: DEVICE,
    text: '给这两张图拟定白底图计划',
    references: [
      { imageId: 'first', mediaId: first },
      { imageId: 'second', mediaId: second },
    ],
  })
  expect(turn.status).toBe(200)
  await turn.text()
  const { batches } = await (await request(`agent/conversations/${conversation.id}/batches`)).json()
  expect(batches).toHaveLength(1)
  const path = `agent/batches/${batches[0].id}`
  const draft = await (await request(path)).json()
  expect(draft.batch.estimate.generation).toMatchObject({ estimatedChargeCredits: 14 })
  const confirm = {
    commandId: 'confirm-two-images',
    expectedVersion: draft.batch.version,
    expectedDigest: draft.batch.digest,
    deviceId: DEVICE,
  }
  const accepted = await request(`${path}/confirm`, confirm)
  expect(accepted.status).toBe(200)
  const repeated = await request(`${path}/confirm`, confirm)
  expect(repeated.status).toBe(200)
  const restored = await (await request(path)).json()
  expect(restored.batch).toMatchObject({ status: 'running', submittedCount: 2 })
  expect(restored.items).toMatchObject([
    { key: 'first', execution: { status: 'queued' } },
    { key: 'second', execution: { status: 'queued' } },
  ])
  const taskIds: string[] = restored.items.map(
    (item: { execution: { taskId: string } }) => item.execution.taskId,
  )
  expect(new Set(taskIds).size).toBe(2)
  expect(billing.reservations.filter((one) => one.model !== 'fixture-agent-model')).toHaveLength(2)
  const requests: string[] = []
  const result = await sharp({
    create: { width: 8, height: 6, channels: 4, background: '#eeeeee' },
  })
    .png()
    .toBuffer()
  setUpstreamFetchForTesting(async (_url, init) => {
    const form = init?.body
    requests.push(form instanceof FormData ? String(form.get('prompt')) : String(form))
    return Response.json({ data: [{ b64_json: result.toString('base64') }] })
  })
  // New worker invocations use only task IDs recovered through HTTP, not the confirmation response.
  for (const taskId of taskIds) await runTask(taskId)
  const completed = await (await request(path)).json()
  expect(completed.batch).toMatchObject({ status: 'closed', submittedCount: 2, actualCredits: 14 })
  expect(completed.items).toMatchObject([
    { key: 'first', execution: { taskId: taskIds[0], status: 'completed', actualCredits: 7 } },
    { key: 'second', execution: { taskId: taskIds[1], status: 'completed', actualCredits: 7 } },
  ])
  expect(requests).toHaveLength(2)
  expect(requests[0]).toContain('第一张保持红色包装并换白底')
  expect(requests[1]).toContain('第二张保持蓝色包装并换白底')
  for (const id of taskIds) {
    const output = await request(`v1/queue/requests/${id}`)
    expect(output.status).toBe(200)
    expect(await output.json()).toMatchObject({
      request_id: id,
      status: 'completed',
      images: [{ index: 0, mime: 'image/png' }],
    })
    expect((await request(`v1/queue/requests/${id}/image/0`)).status).toBe(200)
    expect(billing.settlements.filter((one) => one.taskId === id)).toHaveLength(1)
  }
  expect((await request(`${path}/confirm`, confirm)).status).toBe(200)
  expect(billing.reservations.filter((one) => one.model !== 'fixture-agent-model')).toHaveLength(2)
})

it('暂停与第二项准备竞态后不再提交，已入队项继续完成，恢复只提交剩余项', async () => {
  billing.reset()
  billing.answer = { kind: 'reserved', credits: 7 }
  billing.settledCredits = 7
  const first = await upload('#334455')
  const second = await upload('#556677')
  const { conversation } = await (await request('agent/conversations', { deviceId: DEVICE })).json()
  setAgentFetchForTesting(
    scriptedAgentFetch(
      [],
      [
        () =>
          toolCallCompletion({
            id: 'pause-batch',
            name: 'planImageBatch',
            args: {
              title: '暂停后继续的两张图',
              rule: '各自换白底',
              items: [
                { key: 'first', imageIds: ['first'], prompt: '第一张换白底', dependencies: [] },
                { key: 'second', imageIds: ['second'], prompt: '第二张换白底', dependencies: [] },
              ],
            },
          }),
        () => completionStream('请确认完整计划'),
      ],
    ),
  )
  await (
    await request(`agent/conversations/${conversation.id}/turns`, {
      deviceId: DEVICE,
      text: '先拟两张图的计划',
      references: [
        { imageId: 'first', mediaId: first },
        { imageId: 'second', mediaId: second },
      ],
    })
  ).text()
  const { batches } = await (await request(`agent/conversations/${conversation.id}/batches`)).json()
  const path = `agent/batches/${batches[0].id}`
  const draft = await (await request(path)).json()
  const confirmation = {
    commandId: 'confirm-pausable',
    expectedVersion: draft.batch.version,
    expectedDigest: draft.batch.digest,
    deviceId: DEVICE,
  }
  let release!: () => void
  let prepared!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const preparingSecond = new Promise<void>((resolve) => {
    prepared = resolve
  })
  let reads = 0
  storage.beforeRead = async () => {
    if (++reads === 2) {
      prepared()
      await blocked
    }
  }
  const confirming = request(`${path}/confirm`, confirmation)
  let firstTaskId = ''
  try {
    await preparingSecond
    const paused = await request(`${path}/pause`, {
      commandId: 'pause-during-prepare',
      expectedVersion: 1,
    })
    expect(paused.status).toBe(200)
    const page = await paused.json()
    expect(page.batch).toMatchObject({ status: 'paused', submittedCount: 1 })
    firstTaskId = page.items[0].execution.taskId
    expect(page.items[1].execution).toBeUndefined()
  } finally {
    storage.beforeRead = undefined
    release()
    await confirming
  }
  const afterPrepare = await (await request(path)).json()
  expect(afterPrepare.batch).toMatchObject({ status: 'paused', submittedCount: 1 })
  expect(afterPrepare.items[1].execution).toBeUndefined()
  expect(billing.reservations.filter((one) => one.model !== 'fixture-agent-model')).toHaveLength(1)
  const result = await sharp({
    create: { width: 8, height: 6, channels: 4, background: '#dddddd' },
  })
    .png()
    .toBuffer()
  let dispatches = 0
  setUpstreamFetchForTesting(async () => {
    dispatches++
    return Response.json({ data: [{ b64_json: result.toString('base64') }] })
  })
  await runTask(firstTaskId)
  const whilePaused = await (await request(path)).json()
  expect(whilePaused.batch).toMatchObject({ status: 'paused', submittedCount: 1, actualCredits: 7 })
  expect(whilePaused.items[0].execution.status).toBe('completed')
  const resume = { ...confirmation, commandId: 'resume-pausable' }
  expect((await request(`${path}/resume`, resume)).status).toBe(200)
  expect((await request(`${path}/resume`, resume)).status).toBe(200)
  const resumed = await (await request(path)).json()
  expect(resumed.batch).toMatchObject({ status: 'running', submittedCount: 2 })
  expect(resumed.items[0].execution.taskId).toBe(firstTaskId)
  expect(resumed.items[1].execution.status).toBe('queued')
  await runTask(resumed.items[1].execution.taskId)
  expect((await (await request(path)).json()).batch).toMatchObject({
    status: 'closed',
    submittedCount: 2,
    actualCredits: 14,
  })
  expect(dispatches).toBe(2)
  expect(billing.reservations.filter((one) => one.model !== 'fixture-agent-model')).toHaveLength(2)
})

it('未提交项涨价时暂停并重新报价确认，已提交项跨版本仍是原任务', async () => {
  billing.reset()
  billing.decide = (one) => ({
    kind: 'reserved',
    credits: one.model === 'fixture-agent-model' ? 0 : imageUnitCredits,
  })
  const first = await upload('#778899')
  const second = await upload('#99aabb')
  const { conversation } = await (await request('agent/conversations', { deviceId: DEVICE })).json()
  setAgentFetchForTesting(
    scriptedAgentFetch(
      [],
      [
        () =>
          toolCallCompletion({
            id: 'price-batch',
            name: 'planImageBatch',
            args: {
              title: '改价保护',
              rule: '分别换白底',
              items: [
                { key: 'first', imageIds: ['first'], prompt: '第一张白底图', dependencies: [] },
                { key: 'second', imageIds: ['second'], prompt: '第二张白底图', dependencies: [] },
              ],
            },
          }),
        () => completionStream('请确认报价'),
      ],
    ),
  )
  await (
    await request(`agent/conversations/${conversation.id}/turns`, {
      deviceId: DEVICE,
      text: '先拟两张图的计划',
      references: [
        { imageId: 'first', mediaId: first },
        { imageId: 'second', mediaId: second },
      ],
    })
  ).text()
  const { batches } = await (await request(`agent/conversations/${conversation.id}/batches`)).json()
  const path = `agent/batches/${batches[0].id}`
  const draft = await (await request(path)).json()
  let release!: () => void
  let prepared!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const preparingSecond = new Promise<void>((resolve) => {
    prepared = resolve
  })
  let reads = 0
  storage.beforeRead = async () => {
    if (++reads === 2) {
      prepared()
      await blocked
    }
  }
  const confirm = {
    commandId: 'confirm-price-v1',
    expectedVersion: 1,
    expectedDigest: draft.batch.digest,
    deviceId: DEVICE,
  }
  const confirming = request(`${path}/confirm`, confirm)
  await preparingSecond
  const firstTask = (await (await request(path)).json()).items[0].execution.taskId
  imageUnitCredits = 11
  storage.beforeRead = undefined
  release()
  const stopped = await confirming
  expect(stopped.status).toBe(200)
  expect((await stopped.json()).batch).toMatchObject({
    status: 'paused',
    pauseReason: 'price_changed',
    submittedCount: 1,
  })
  expect(billing.reservations.filter((one) => one.model !== 'fixture-agent-model')).toHaveLength(1)
  expect(
    (await request(`${path}/resume`, { ...confirm, commandId: 'resume-stale-price' })).status,
  ).toBe(409)
  const refreshed = await request(`${path}/reprice`, {
    commandId: 'reprice-v2',
    expectedVersion: 1,
  })
  expect(refreshed.status).toBe(200)
  const quoted = await refreshed.json()
  expect(quoted.batch).toMatchObject({
    version: 2,
    status: 'paused',
    confirmationRequired: true,
    itemCount: 2,
    estimate: { generation: { estimatedChargeCredits: 18 } },
  })
  expect(quoted.items[0].execution.taskId).toBe(firstTask)
  expect(quoted.items[1].execution).toBeUndefined()
  expect(quoted.batch.estimate.generation.snapshots).toMatchObject([
    { itemKey: 'first', baseUnitCredits: 7, pricingVersion: 'price-7' },
    { itemKey: 'second', baseUnitCredits: 11, pricingVersion: 'price-11' },
  ])
  expect(
    (await request(`${path}/reprice`, { commandId: 'reprice-v2', expectedVersion: 1 })).status,
  ).toBe(200)
  expect((await (await request(path)).json()).batch.version).toBe(2)
  expect((await request(`${path}/confirm`, confirm)).status).toBe(409)
  const updated = {
    ...confirm,
    commandId: 'confirm-price-v2',
    expectedVersion: 2,
    expectedDigest: quoted.batch.digest,
  }
  expect((await request(`${path}/confirm`, updated)).status).toBe(200)
  expect((await request(`${path}/confirm`, updated)).status).toBe(200)
  const resumed = await (await request(path)).json()
  expect(resumed.batch).toMatchObject({ status: 'running', submittedCount: 2, version: 2 })
  expect(resumed.items[0].execution.taskId).toBe(firstTask)
  expect(resumed.items[1].execution.taskId).not.toBe(firstTask)
  expect(billing.reservations.filter((one) => one.model !== 'fixture-agent-model')).toHaveLength(2)
})

it('公共余额不足暂停后续派发，补足后恢复只提交未入队项', async () => {
  billing.reset()
  billing.answer = { kind: 'reserved', credits: 7 }
  let generationReservations = 0
  let enoughCredits = false
  billing.decide = (one) => {
    if (one.model === 'fixture-agent-model') return { kind: 'reserved', credits: 0 }
    generationReservations++
    return !enoughCredits && generationReservations > 1
      ? { kind: 'insufficient_credits', required: 7, available: 0 }
      : { kind: 'reserved', credits: 7 }
  }
  const first = await upload('#224466')
  const second = await upload('#6688aa')
  const { conversation } = await (await request('agent/conversations', { deviceId: DEVICE })).json()
  setAgentFetchForTesting(
    scriptedAgentFetch(
      [],
      [
        () =>
          toolCallCompletion({
            id: 'credits-batch',
            name: 'planImageBatch',
            args: {
              title: '余额保护',
              rule: '分别换白底',
              items: [
                { key: 'first', imageIds: ['first'], prompt: '第一张换白底', dependencies: [] },
                { key: 'second', imageIds: ['second'], prompt: '第二张换白底', dependencies: [] },
              ],
            },
          }),
        () => completionStream('请确认计划'),
      ],
    ),
  )
  await (
    await request(`agent/conversations/${conversation.id}/turns`, {
      deviceId: DEVICE,
      text: '先拟两张图的计划',
      references: [
        { imageId: 'first', mediaId: first },
        { imageId: 'second', mediaId: second },
      ],
    })
  ).text()
  const { batches } = await (await request(`agent/conversations/${conversation.id}/batches`)).json()
  const path = `agent/batches/${batches[0].id}`
  const draft = await (await request(path)).json()
  const confirm = {
    commandId: 'confirm-credits',
    expectedVersion: 1,
    expectedDigest: draft.batch.digest,
    deviceId: DEVICE,
  }
  const response = await request(`${path}/confirm`, confirm)
  expect(response.status).toBe(200)
  const paused = await response.json()
  expect(paused.batch).toMatchObject({
    status: 'paused',
    pauseReason: 'insufficient_credits',
    submittedCount: 1,
  })
  expect(paused.items[0].execution.status).toBe('queued')
  expect(paused.items[1].execution).toBeUndefined()
  const taskId = paused.items[0].execution.taskId
  expect((await request(`${path}/confirm`, confirm)).status).toBe(200)
  expect(generationReservations).toBe(2)
  enoughCredits = true
  const resume = { ...confirm, commandId: 'resume-with-credits' }
  expect((await request(`${path}/resume`, resume)).status).toBe(200)
  expect((await request(`${path}/resume`, resume)).status).toBe(200)
  const resumed = await (await request(path)).json()
  expect(resumed.batch).toMatchObject({ status: 'running', pauseReason: null, submittedCount: 2 })
  expect(resumed.items[0].execution.taskId).toBe(taskId)
  expect(resumed.items[1].execution.taskId).not.toBe(taskId)
  expect(generationReservations).toBe(3)
})

it('批次执行携带被冻结的原件和遮罩，动作与编号区域进入真实生成指令', async () => {
  billing.reset()
  billing.answer = { kind: 'reserved', credits: 7 }
  const original = await sharp({
    create: { width: 1024, height: 1024, channels: 4, background: '#dd4422' },
  })
    .png()
    .toBuffer()
  const mask = await sharp({
    create: { width: 1024, height: 1024, channels: 4, background: '#00000000' },
  })
    .png()
    .toBuffer()
  const mediaId = await upload(original)
  const maskMediaId = await upload(mask)
  const reference = {
    imageId: 'selected',
    mediaId,
    maskMediaId,
    editAction: 'erase',
    regions: [{ x: 0, y: 0, width: 1, height: 1 }],
  }
  const { conversation } = await (await request('agent/conversations', { deviceId: DEVICE })).json()
  setAgentFetchForTesting(
    scriptedAgentFetch(
      [],
      [
        () =>
          toolCallCompletion({
            id: 'masked-batch',
            name: 'planImageBatch',
            args: {
              title: '擦除标记',
              rule: '擦掉标记并补全背景',
              items: [
                {
                  key: 'selected',
                  imageIds: ['selected'],
                  prompt: '擦掉红色标记，保留白色背景',
                  dependencies: [],
                },
              ],
            },
          }),
        () => completionStream('请确认选区计划'),
      ],
    ),
  )
  const turn = await request(`agent/conversations/${conversation.id}/turns`, {
    deviceId: DEVICE,
    text: '批量擦掉圈选的红色标记，先给出计划',
    references: [reference],
  })
  expect(turn.status).toBe(200)
  await turn.text()
  const { batches } = await (await request(`agent/conversations/${conversation.id}/batches`)).json()
  expect(batches).toHaveLength(1)
  const path = `agent/batches/${batches[0].id}`
  const draft = await (await request(path)).json()
  expect(draft.items[0].inputs).toEqual([reference])
  const confirmed = await request(`${path}/confirm`, {
    commandId: 'confirm-masked',
    expectedVersion: 1,
    expectedDigest: draft.batch.digest,
    deviceId: DEVICE,
  })
  expect(confirmed.status).toBe(200)
  const restored = await (await request(path)).json()
  const sent: { original: Buffer; mask: Buffer | null; prompt: string }[] = []
  setUpstreamFetchForTesting(async (_input, init) => {
    const form = init!.body as FormData
    const maskFile = form.get('mask')
    sent.push({
      original: Buffer.from(await (form.get('image[]') as Blob).arrayBuffer()),
      mask: maskFile instanceof Blob ? Buffer.from(await maskFile.arrayBuffer()) : null,
      prompt: String(form.get('prompt')),
    })
    return Response.json({ data: [{ b64_json: original.toString('base64') }] })
  })
  await runTask(restored.items[0].execution.taskId)
  expect(sent).toHaveLength(1)
  expect(sent[0]!.original).toEqual(original)
  expect(sent[0]!.mask).toEqual(mask)
  expect(sent[0]!.prompt).toContain('擦除')
  expect(sent[0]!.prompt).toContain('区域 1')
  expect(sent[0]!.prompt).toContain('擦掉红色标记，保留白色背景')
  expect((await (await request(path)).json()).items[0].execution.status).toBe('completed')
})

it('超过单任务图片上限的批次在确认前明确拒绝，不读取原件或预扣，也不截断输入', async () => {
  billing.reset()
  billing.answer = { kind: 'reserved', credits: 7 }
  const mediaId = await upload('#556677')
  const references = Array.from({ length: 17 }, (_, index) => ({
    imageId: `reference-${index + 1}`,
    mediaId,
  }))
  const { conversation } = await (await request('agent/conversations', { deviceId: DEVICE })).json()
  setAgentFetchForTesting(
    scriptedAgentFetch(
      [],
      [
        () =>
          toolCallCompletion({
            id: 'too-many-inputs',
            name: 'planImageBatch',
            args: {
              title: '十七张共同参考',
              rule: '保留全部参考图',
              items: [
                {
                  key: 'combined',
                  imageIds: references.map((reference) => reference.imageId),
                  prompt: '使用全部十七张参考图绘制海报',
                  dependencies: [],
                },
              ],
            },
          }),
        () => completionStream('请确认完整计划'),
      ],
    ),
  )
  const turn = await request(`agent/conversations/${conversation.id}/turns`, {
    deviceId: DEVICE,
    text: '以这十七张为共同参考，先拟计划',
    references,
  })
  expect(turn.status).toBe(200)
  await turn.text()
  const { batches } = await (await request(`agent/conversations/${conversation.id}/batches`)).json()
  expect(batches).toHaveLength(1)
  const path = `agent/batches/${batches[0].id}`
  const draft = await (await request(path)).json()
  expect(draft.items[0].inputs).toHaveLength(17)
  const storageStart = storage.events.length
  const response = await request(`${path}/confirm`, {
    commandId: 'confirm-too-many-inputs',
    expectedVersion: 1,
    expectedDigest: draft.batch.digest,
    deviceId: DEVICE,
  })
  expect(response.status).toBe(422)
  expect(await response.json()).toEqual({ error: 'batch_input_limit' })
  expect(
    storage.events.slice(storageStart).filter((event) => /^(read|open|stream):/.test(event)),
  ).toEqual([])
  expect(billing.reservations.filter((one) => one.model !== 'fixture-agent-model')).toHaveLength(0)
  const restored = await (await request(path)).json()
  expect(restored.batch).toMatchObject({
    status: 'draft',
    submittedCount: 0,
    confirmationRequired: true,
  })
  expect(restored.items[0].inputs).toHaveLength(17)
  expect(restored.items[0].execution).toBeUndefined()
})

it('原件超过准备字节预算时在流读取前暂停，刷新可见原因且不预扣生成费用', async () => {
  billing.reset()
  billing.answer = { kind: 'reserved', credits: 7 }
  const mediaId = await upload('#778899')
  const { conversation } = await (await request('agent/conversations', { deviceId: DEVICE })).json()
  setAgentFetchForTesting(
    scriptedAgentFetch(
      [],
      [
        () =>
          toolCallCompletion({
            id: 'oversized-original',
            name: 'planImageBatch',
            args: {
              title: '原图字节保护',
              rule: '完整原图换白底',
              items: [
                {
                  key: 'original',
                  imageIds: ['original'],
                  prompt: '保留原图细节并换白底',
                  dependencies: [],
                },
              ],
            },
          }),
        () => completionStream('请确认完整计划'),
      ],
    ),
  )
  await (
    await request(`agent/conversations/${conversation.id}/turns`, {
      deviceId: DEVICE,
      text: '先拟定白底图计划',
      references: [{ imageId: 'original', mediaId }],
    })
  ).text()
  const { batches } = await (await request(`agent/conversations/${conversation.id}/batches`)).json()
  expect(batches).toHaveLength(1)
  const path = `agent/batches/${batches[0].id}`
  const draft = await (await request(path)).json()
  // The storage boundary advertises a large object without allocating its body in the fixture.
  storage.advertisedSize = 32 * 1024 * 1024
  const start = storage.events.length
  try {
    const response = await request(`${path}/confirm`, {
      commandId: 'confirm-byte-budget',
      expectedVersion: 1,
      expectedDigest: draft.batch.digest,
      deviceId: DEVICE,
    })
    expect(response.status).toBe(200)
    expect((await response.json()).batch).toMatchObject({
      status: 'paused',
      pauseReason: 'input_limit',
      submittedCount: 0,
    })
    expect(storage.events.slice(start).filter((event) => event.startsWith('open:'))).toHaveLength(1)
    expect(storage.events.slice(start).filter((event) => /^(read|stream):/.test(event))).toEqual([])
    expect(billing.reservations.filter((one) => one.model !== 'fixture-agent-model')).toHaveLength(
      0,
    )
    expect((await (await request(path)).json()).batch).toMatchObject({
      status: 'paused',
      pauseReason: 'input_limit',
      submittedCount: 0,
    })
  } finally {
    storage.advertisedSize = undefined
  }
})

for (const billingAvailable of [true, false]) {
  it(`任务保留期清理后批次仍恢复确定终态、实扣和产物归属，重复确认不再派发（计费可用：${billingAvailable}）`, async () => {
    billing.answer = { kind: 'reserved', credits: 7 }
    billing.settledCredits = 7
    const mediaId = await upload('#778899')
    const { conversation } = await (
      await request('agent/conversations', { deviceId: DEVICE })
    ).json()
    setAgentFetchForTesting(
      scriptedAgentFetch(
        [],
        [
          () =>
            toolCallCompletion({
              id: 'retained-batch',
              name: 'planImageBatch',
              args: {
                title: '保存完成明细',
                rule: '换成白底',
                items: [
                  {
                    key: 'retained',
                    imageIds: ['original'],
                    prompt: '原图换成白色背景',
                    dependencies: [],
                  },
                ],
              },
            }),
          () => completionStream('请确认计划'),
        ],
      ),
    )
    await (
      await request(`agent/conversations/${conversation.id}/turns`, {
        deviceId: DEVICE,
        text: '把原图换成白色背景，先拟计划',
        references: [{ imageId: 'original', mediaId }],
      })
    ).text()
    const { batches } = await (
      await request(`agent/conversations/${conversation.id}/batches`)
    ).json()
    expect(batches).toHaveLength(1)
    const path = `agent/batches/${batches[0].id}`
    const draft = await (await request(path)).json()
    const confirm = {
      commandId: `confirm-retained-${billingAvailable}`,
      expectedVersion: 1,
      expectedDigest: draft.batch.digest,
      deviceId: DEVICE,
    }
    const accepted = await request(`${path}/confirm`, confirm)
    expect(accepted.status).toBe(200)
    const taskId = (await accepted.json()).items[0].execution.taskId
    const output = await sharp({
      create: { width: 8, height: 6, channels: 4, background: '#ffffff' },
    })
      .png()
      .toBuffer()
    let calls = 0
    setUpstreamFetchForTesting(async () => {
      calls++
      return Response.json({ data: [{ b64_json: output.toString('base64') }] })
    })
    await runTask(taskId)
    if (!billingAvailable) {
      const previousOperator = config.operator
      const previousOverlay = await loadPrivateBffOverlay()
      config.operator = {
        ...previousOperator,
        capabilities: { ...previousOperator.capabilities, 'billing:credits': false },
      }
      _setPrivateBffOverlayForTesting({
        ...previousOverlay,
        taskHooks: {
          ...previousOverlay.taskHooks,
          async taskCredits() {
            return {}
          },
        },
      })
      try {
        await purgeOldTasks(-1)
        // Turning billing off cannot replace an earlier reservation's unknown bill with zero.
        expect((await request(`v1/queue/requests/${taskId}/status`)).status).toBe(200)
        const [attempt] = await db
          .select()
          .from(schema.agent_batch_attempts)
          .where(eq(schema.agent_batch_attempts.task_id, taskId))
        expect(attempt!.terminal_snapshot).toBeNull()
      } finally {
        config.operator = previousOperator
        _setPrivateBffOverlayForTesting(previousOverlay)
      }
    }
    // Maintenance must preserve the accepted result even when no client ever read its completion.
    expect(await purgeOldTasks(-1)).toBeGreaterThanOrEqual(1)
    const retainedOutput = await request(`v1/queue/requests/${taskId}/output/0`)
    expect(retainedOutput.status).toBe(200)
    expect(Buffer.from(await retainedOutput.arrayBuffer())).toEqual(output)
    const restored = await (await request(path)).json()
    expect(restored.batch).toMatchObject({ status: 'closed', submittedCount: 1, actualCredits: 7 })
    expect(restored.items[0].execution).toMatchObject({
      taskId,
      status: 'completed',
      attempt: 1,
      actualCredits: 7,
      artifacts: [{ taskId, outputIndex: 0, media: 'image', mime: 'image/png' }],
    })
    expect((await request(`${path}/confirm`, confirm)).status).toBe(200)
    expect(billing.reservations.filter((one) => one.model !== 'fixture-agent-model')).toHaveLength(
      1,
    )
    expect(calls).toBe(1)
  })
}

it('批次确认与同账号持久事件并发时不死锁或重做预扣', async () => {
  billing.answer = { kind: 'reserved', credits: 7 }
  const mediaId = await upload('#637584')
  const { conversation } = await (await request('agent/conversations', { deviceId: DEVICE })).json()
  setAgentFetchForTesting(
    scriptedAgentFetch(
      [],
      [
        () =>
          toolCallCompletion({
            id: 'event-lock-batch',
            name: 'planImageBatch',
            args: {
              title: '事件并发',
              rule: '换白底',
              items: [
                {
                  key: 'one',
                  imageIds: ['original'],
                  prompt: '原图换成白色背景',
                  dependencies: [],
                },
              ],
            },
          }),
        () => completionStream('请确认计划'),
      ],
    ),
  )
  await (
    await request(`agent/conversations/${conversation.id}/turns`, {
      deviceId: DEVICE,
      text: '先拟换白底计划',
      references: [{ imageId: 'original', mediaId }],
    })
  ).text()
  const { batches } = await (await request(`agent/conversations/${conversation.id}/batches`)).json()
  expect(batches).toHaveLength(1)
  const path = `agent/batches/${batches[0].id}`
  const draft = await (await request(path)).json()
  const userId = 'batch-execution-owner'
  await db.insert(schema.user_change_heads).values({ user_id: userId }).onConflictDoNothing()
  let releasePublication = () => {}
  const publicationGate = new Promise<void>((resolve) => {
    releasePublication = resolve
  })
  let headLocked = false
  const publication = db
    .transaction(async (tx) => {
      const [head] = await tx
        .update(schema.user_change_heads)
        .set({ sequence: sql`${schema.user_change_heads.sequence} + 1` })
        .where(eq(schema.user_change_heads.user_id, userId))
        .returning()
      headLocked = true
      await publicationGate
      await tx.insert(schema.user_changes).values({
        user_id: userId,
        sequence: head!.sequence,
        changes: [],
        created_at: Date.now(),
      })
    })
    .then(
      () => null,
      (error: unknown) => error,
    )
  await waitFor(() => headLocked)
  const confirmation = request(`${path}/confirm`, {
    commandId: 'confirm-event-lock',
    expectedVersion: 1,
    expectedDigest: draft.batch.digest,
    deviceId: DEVICE,
  })
  try {
    // The real HTTP transaction holds its owner lock and has reached the event head.
    await waitFor(async () => {
      const waiting = await db.execute(sql`
        SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock' AND query LIKE ${'%insert into "user_change_heads"%'}
      `)
      return waiting.length > 0
    })
  } finally {
    releasePublication()
  }
  expect(await publication).toBeNull()
  const response = await confirmation
  expect(response.status).toBe(200)
  expect((await response.json()).batch.submittedCount).toBe(1)
  expect(billing.reservations.filter((one) => one.model !== 'fixture-agent-model')).toHaveLength(1)
}, 10000)

it('只重试选中的明确失败项，按当前报价确认一次并保留原失败账单', async () => {
  billing.answer = { kind: 'reserved', credits: 7 }
  billing.settledCredits = 7
  const mediaId = await upload('#728394')
  const { conversation } = await (await request('agent/conversations', { deviceId: DEVICE })).json()
  const agentCalls: Parameters<typeof scriptedAgentFetch>[0] = []
  setAgentFetchForTesting(
    scriptedAgentFetch(agentCalls, [
      () =>
        toolCallCompletion({
          id: 'retry-batch',
          name: 'planImageBatch',
          args: {
            title: '保留成功项的重试',
            rule: '分别换白底和蓝底',
            items: [
              {
                key: 'failed',
                imageIds: ['original'],
                prompt: '原图换成白色背景',
                dependencies: [],
              },
              {
                key: 'success',
                imageIds: ['original'],
                prompt: '原图换成蓝色背景',
                dependencies: [],
              },
            ],
          },
        }),
      () => completionStream('请确认两项计划'),
    ]),
  )
  await (
    await request(`agent/conversations/${conversation.id}/turns`, {
      deviceId: DEVICE,
      text: '先拟白底蓝底两项计划',
      references: [{ imageId: 'original', mediaId }],
    })
  ).text()
  const { batches } = await (await request(`agent/conversations/${conversation.id}/batches`)).json()
  expect(batches).toHaveLength(1)
  const path = `agent/batches/${batches[0].id}`
  const draft = await (await request(path)).json()
  const confirmed = await request(`${path}/confirm`, {
    commandId: 'confirm-before-retry',
    expectedVersion: 1,
    expectedDigest: draft.batch.digest,
    deviceId: DEVICE,
  })
  expect(confirmed.status).toBe(200)
  const initial = await confirmed.json()
  const failedId = initial.items[0].execution.taskId
  const successId = initial.items[1].execution.taskId
  const requests: { prompt: string; bytes: number[] }[] = []
  const output = await sharp({
    create: { width: 8, height: 6, channels: 4, background: '#ffffff' },
  })
    .png()
    .toBuffer()
  setUpstreamFetchForTesting(async (_input, init) => {
    const body = init!.body as FormData
    const image = body.get('image[]') ?? body.get('image')
    requests.push({
      prompt: String(body.get('prompt')),
      bytes: image instanceof Blob ? [...new Uint8Array(await image.arrayBuffer())] : [],
    })
    return requests.length === 1
      ? Response.json(
          { error: { message: 'This image could not be processed', code: 'invalid_image' } },
          { status: 400 },
        )
      : Response.json({ data: [{ b64_json: output.toString('base64') }] })
  })
  await runTask(failedId)
  await runTask(successId)
  const beforeRetry = await (await request(path)).json()
  expect(beforeRetry.batch).toMatchObject({ status: 'closed', actualCredits: 7, submittedCount: 2 })
  expect(
    beforeRetry.items.map((item: { execution: { status: string } }) => item.execution.status),
  ).toEqual(['failed', 'completed'])
  const originalAgentCalls = agentCalls.length
  imageUnitCredits = 11
  const selection = {
    commandId: 'quote-selected-failure',
    expectedVersion: 1,
    itemKeys: ['failed'],
  }
  const quotedResponse = await request(`${path}/retry-quote`, selection)
  expect(quotedResponse.status).toBe(200)
  const quoted = await quotedResponse.json()
  expect(quoted.batch).toMatchObject({
    version: 2,
    status: 'paused',
    confirmationRequired: true,
    retryItemKeys: ['failed'],
    submittedCount: 2,
    estimate: { generation: { status: 'available', estimatedChargeCredits: 11 } },
  })
  const duplicateQuote = await request(`${path}/retry-quote`, selection)
  expect(duplicateQuote.status).toBe(200)
  expect((await duplicateQuote.json()).batch.digest).toBe(quoted.batch.digest)
  expect(requests).toHaveLength(2)
  billing.answer = { kind: 'reserved', credits: 11 }
  billing.settledCredits = 11
  const retryConfirmation = {
    commandId: 'confirm-selected-failure',
    expectedVersion: 2,
    expectedDigest: quoted.batch.digest,
    deviceId: DEVICE,
  }
  const accepted = await request(`${path}/confirm`, retryConfirmation)
  expect(accepted.status).toBe(200)
  const retry = await accepted.json()
  expect(retry.batch.submittedCount).toBe(3)
  const retriedId = retry.items[0].execution.taskId
  expect(retriedId).not.toBe(failedId)
  expect(retry.items[0].execution).toMatchObject({ status: 'queued', attempt: 2 })
  expect(retry.items[1].execution).toMatchObject({
    taskId: successId,
    status: 'completed',
    attempt: 1,
    actualCredits: 7,
  })
  const duplicateConfirm = await request(`${path}/confirm`, retryConfirmation)
  expect(duplicateConfirm.status).toBe(200)
  expect((await duplicateConfirm.json()).items[0].execution.taskId).toBe(retriedId)
  await runTask(retriedId)
  const completed = await (await request(path)).json()
  expect(completed.batch).toMatchObject({ status: 'closed', actualCredits: 18, submittedCount: 3 })
  expect(completed.items[0].execution).toMatchObject({
    taskId: retriedId,
    status: 'completed',
    attempt: 2,
    actualCredits: 11,
  })
  expect(completed.items[0].attempts).toMatchObject([
    { taskId: failedId, status: 'failed', attempt: 1, actualCredits: 0 },
    { taskId: retriedId, status: 'completed', attempt: 2, actualCredits: 11 },
  ])
  expect(completed.items[1].execution.taskId).toBe(successId)
  expect(requests).toHaveLength(3)
  expect(requests[0]!.bytes.length).toBeGreaterThan(0)
  expect(requests[2]).toEqual(requests[0])
  expect(agentCalls).toHaveLength(originalAgentCalls)
  expect(billing.reservations.filter((one) => one.model !== 'fixture-agent-model')).toHaveLength(3)
}, 15000)

it('暂停批次确认失败项重试仍保持暂停，只有明确恢复才提交新尝试和剩余项', async () => {
  billing.answer = { kind: 'reserved', credits: 7 }
  billing.settledCredits = 7
  const mediaId = await upload('#835794')
  const { conversation } = await (await request('agent/conversations', { deviceId: DEVICE })).json()
  setAgentFetchForTesting(
    scriptedAgentFetch(
      [],
      [
        () =>
          toolCallCompletion({
            id: 'paused-retry-batch',
            name: 'planImageBatch',
            args: {
              title: '暂停后选择重试',
              rule: '分别换背景',
              items: [
                {
                  key: 'failed',
                  imageIds: ['original'],
                  prompt: '原图换成白色背景',
                  dependencies: [],
                },
                {
                  key: 'success',
                  imageIds: ['original'],
                  prompt: '原图换成蓝色背景',
                  dependencies: [],
                },
                {
                  key: 'pending',
                  imageIds: ['original'],
                  prompt: '原图换成绿色背景',
                  dependencies: [],
                },
              ],
            },
          }),
        () => completionStream('请确认三项计划'),
      ],
    ),
  )
  await (
    await request(`agent/conversations/${conversation.id}/turns`, {
      deviceId: DEVICE,
      text: '先拟三色背景计划',
      references: [{ imageId: 'original', mediaId }],
    })
  ).text()
  const { batches } = await (await request(`agent/conversations/${conversation.id}/batches`)).json()
  expect(batches).toHaveLength(1)
  const path = `agent/batches/${batches[0].id}`
  const draft = await (await request(path)).json()
  const initialResponse = await request(`${path}/confirm`, {
    commandId: 'confirm-paused-retry-original',
    expectedVersion: 1,
    expectedDigest: draft.batch.digest,
    deviceId: DEVICE,
  })
  expect(initialResponse.status).toBe(200)
  const initial = await initialResponse.json()
  expect(initial.batch.submittedCount).toBe(2)
  const output = await sharp({
    create: { width: 8, height: 6, channels: 4, background: '#ffffff' },
  })
    .png()
    .toBuffer()
  let calls = 0
  setUpstreamFetchForTesting(async () => {
    calls++
    return calls === 1
      ? Response.json(
          { error: { message: 'Invalid image', code: 'invalid_image' } },
          { status: 400 },
        )
      : Response.json({ data: [{ b64_json: output.toString('base64') }] })
  })
  await runTask(initial.items[0].execution.taskId)
  await runTask(initial.items[1].execution.taskId)
  expect(
    (await request(`${path}/pause`, { commandId: 'pause-before-retry', expectedVersion: 1 }))
      .status,
  ).toBe(200)
  const quoteResponse = await request(`${path}/retry-quote`, {
    commandId: 'quote-while-paused',
    expectedVersion: 1,
    itemKeys: ['failed'],
  })
  expect(quoteResponse.status).toBe(200)
  const quoted = await quoteResponse.json()
  expect(quoted.batch.retryRequiresResume).toBe(true)
  const confirmation = {
    commandId: 'confirm-while-paused',
    expectedVersion: quoted.batch.version,
    expectedDigest: quoted.batch.digest,
    deviceId: DEVICE,
  }
  const approvedResponse = await request(`${path}/confirm`, confirmation)
  expect(approvedResponse.status).toBe(200)
  const approved = await approvedResponse.json()
  expect(approved.batch).toMatchObject({
    status: 'paused',
    confirmationRequired: false,
    submittedCount: 2,
  })
  expect(approved.items[0].execution).toMatchObject({
    taskId: initial.items[0].execution.taskId,
    attempt: 1,
    status: 'failed',
  })
  expect(approved.items[2].execution).toBeUndefined()
  expect(billing.reservations.filter((one) => one.model !== 'fixture-agent-model')).toHaveLength(2)
  const resumedResponse = await request(`${path}/resume`, {
    ...confirmation,
    commandId: 'resume-authorized-retry',
  })
  expect(resumedResponse.status).toBe(200)
  const resumed = await resumedResponse.json()
  expect(resumed.batch.submittedCount).toBe(4)
  expect(resumed.items[0].execution).toMatchObject({ attempt: 2, status: 'queued' })
  expect(resumed.items[2].execution).toMatchObject({ attempt: 1, status: 'queued' })
  await runTask(resumed.items[0].execution.taskId)
  await runTask(resumed.items[2].execution.taskId)
  const completed = await (await request(path)).json()
  expect(completed.batch).toMatchObject({ status: 'closed', submittedCount: 4, actualCredits: 21 })
  expect(calls).toBe(4)
}, 15000)
