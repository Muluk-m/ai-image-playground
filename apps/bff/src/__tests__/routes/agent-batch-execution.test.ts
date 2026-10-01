import { afterAll, afterEach, beforeAll, expect, it } from 'bun:test'
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

process.env.DATABASE_URL = await resetTestDatabase('bff_agent_batch_execution')
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

async function upload(background: string) {
  const bytes = await sharp({ create: { width: 8, height: 6, channels: 4, background } })
    .png()
    .toBuffer()
  const response = await request('media/uploads', {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    contentType: 'image/png',
    purpose: 'conversation-attachment',
  })
  expect(response.status).toBe(200)
  const media = await response.json()
  await storage.write(new URL(media.uploadUrl).pathname.slice(1), bytes, 'image/png')
  expect((await request(`media/${media.id}/complete`, {})).status).toBe(200)
  return media.id as string
}

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
