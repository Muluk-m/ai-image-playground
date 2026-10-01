import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { DEVICE_ID_HEADER } from '@image-playground/shared'
import { eq } from 'drizzle-orm'
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

process.env.DATABASE_URL = await resetTestDatabase('bff_agent_batch_retry_matrix')
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
    id: 'batch-retry-matrix-owner',
    username: 'batch-retry-matrix-owner',
    password_hash: 'fixture',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
  cookie = `${USER_SESSION_COOKIE}=${await db.transaction((tx) => createUserSession('batch-retry-matrix-owner', tx))}`
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

async function plannedThree(background: string, confirm = true) {
  billing.answer = { kind: 'reserved', credits: 7 }
  billing.settledCredits = 7
  const mediaId = await upload(background)
  const { conversation } = await (await request('agent/conversations', { deviceId: DEVICE })).json()
  const modelCalls: AgentCall[] = []
  setAgentFetchForTesting(
    scriptedAgentFetch(modelCalls, [
      () =>
        toolCallCompletion({
          id: 'retry-matrix-plan',
          name: 'planImageBatch',
          args: {
            title: '重试选择范围',
            rule: '三个独立编辑',
            items: ['one', 'two', 'three'].map((key) => ({
              key,
              imageIds: ['original'],
              prompt: `${key}修改白底`,
              dependencies: [],
            })),
          },
        }),
      () => completionStream('请确认三项'),
    ]),
  )
  await (
    await request(`agent/conversations/${conversation.id}/turns`, {
      deviceId: DEVICE,
      text: '拟三个编辑计划',
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
  if (!confirm) return { path, draft, command, initial: draft, modelCalls }
  const initialResponse = await request(`${path}/confirm`, command)
  expect(initialResponse.status).toBe(200)
  return { path, draft, command, initial: await initialResponse.json(), modelCalls }
}

it('多选明确失败以当前报价确认一次，重排重复选择仍同命令，成功项不重试', async () => {
  const { path, command, initial, modelCalls } = await plannedThree('#795184')
  const output = await sharp({
    create: { width: 8, height: 6, channels: 4, background: '#ffffff' },
  })
    .png()
    .toBuffer()
  let calls = 0
  setUpstreamFetchForTesting(async () => {
    calls++
    return calls <= 2
      ? Response.json(
          { error: { message: 'Invalid image', code: 'invalid_image' } },
          { status: 400 },
        )
      : Response.json({ data: [{ b64_json: output.toString('base64') }] })
  })
  await runTask(initial.items[0].execution.taskId)
  await runTask(initial.items[1].execution.taskId)
  const advanced = await (await request(`${path}/confirm`, command)).json()
  const successId = advanced.items[2].execution.taskId
  await runTask(successId)
  expect((await (await request(path)).json()).batch).toMatchObject({
    status: 'closed',
    actualCredits: 7,
    submittedCount: 3,
  })
  imageUnitCredits = 11
  const selection = { commandId: 'quote-multiple', expectedVersion: 1, itemKeys: ['two', 'one'] }
  const quotedResponse = await request(`${path}/retry-quote`, selection)
  expect(quotedResponse.status).toBe(200)
  const quoted = await quotedResponse.json()
  expect(quoted.batch).toMatchObject({
    version: 2,
    retryItemKeys: ['one', 'two'],
    estimate: { generation: { estimatedChargeCredits: 22 } },
  })
  const same = await request(`${path}/retry-quote`, {
    ...selection,
    itemKeys: ['one', 'two', 'one'],
  })
  expect(same.status).toBe(200)
  expect((await same.json()).batch.digest).toBe(quoted.batch.digest)
  expect(calls).toBe(3)
  billing.answer = { kind: 'reserved', credits: 11 }
  billing.settledCredits = 11
  const confirm = {
    commandId: 'confirm-multiple-retry',
    expectedVersion: 2,
    expectedDigest: quoted.batch.digest,
    deviceId: DEVICE,
  }
  const acceptedResponse = await request(`${path}/confirm`, confirm)
  expect(acceptedResponse.status).toBe(200)
  const accepted = await acceptedResponse.json()
  expect(accepted.batch.submittedCount).toBe(5)
  expect(
    accepted.items
      .slice(0, 2)
      .map((item: { execution: { attempt: number } }) => item.execution.attempt),
  ).toEqual([2, 2])
  expect(accepted.items[2].execution).toMatchObject({
    taskId: successId,
    attempt: 1,
    actualCredits: 7,
  })
  const duplicate = await (await request(`${path}/confirm`, confirm)).json()
  expect(
    duplicate.items.map((item: { execution: { taskId: string } }) => item.execution.taskId),
  ).toEqual(accepted.items.map((item: { execution: { taskId: string } }) => item.execution.taskId))
  await runTask(accepted.items[0].execution.taskId)
  await runTask(accepted.items[1].execution.taskId)
  const result = await (await request(path)).json()
  expect(result.batch).toMatchObject({ status: 'closed', actualCredits: 29, submittedCount: 5 })
  expect(result.items[0].attempts).toMatchObject([
    { taskId: initial.items[0].execution.taskId, status: 'failed', actualCredits: 0 },
    { attempt: 2, status: 'completed', actualCredits: 11 },
  ])
  expect(result.items[1].attempts).toMatchObject([
    { taskId: initial.items[1].execution.taskId, status: 'failed', actualCredits: 0 },
    { attempt: 2, status: 'completed', actualCredits: 11 },
  ])
  expect(calls).toBe(5)
  expect(modelCalls).toHaveLength(2)
  expect(billing.reservations.filter((one) => one.model !== 'fixture-agent-model')).toHaveLength(5)
}, 20000)

it('成功、结果未知和已入队项均禁止重试，拒绝不创建版本或释放未知预扣', async () => {
  const { path, command, initial, modelCalls } = await plannedThree('#184957')
  const output = await sharp({
    create: { width: 8, height: 6, channels: 4, background: '#ffffff' },
  })
    .png()
    .toBuffer()
  let calls = 0
  setUpstreamFetchForTesting(async () => {
    calls++
    if (calls === 2) throw new Error('connection lost after upstream acceptance')
    return Response.json({ data: [{ b64_json: output.toString('base64') }] })
  })
  await runTask(initial.items[0].execution.taskId)
  const unknownId = initial.items[1].execution.taskId
  await runTask(unknownId)
  const baseline = await (await request(`${path}/confirm`, command)).json()
  expect(
    baseline.items.map((item: { execution: { status: string } }) => item.execution.status),
  ).toEqual(['completed', 'reconciling', 'queued'])
  for (const key of ['one', 'two', 'three']) {
    const refused = await request(`${path}/retry-quote`, {
      commandId: `forbidden-${key}`,
      expectedVersion: 1,
      itemKeys: [key],
    })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual({ error: 'batch_retry_unavailable' })
  }
  const after = await (await request(path)).json()
  expect(after.batch).toMatchObject({
    version: 1,
    digest: baseline.batch.digest,
    submittedCount: 3,
  })
  expect(
    after.items.map((item: { execution: { taskId: string } }) => item.execution.taskId),
  ).toEqual(baseline.items.map((item: { execution: { taskId: string } }) => item.execution.taskId))
  await runTask(unknownId)
  expect(calls).toBe(2)
  expect(modelCalls).toHaveLength(2)
  expect(billing.reservations.filter((one) => one.model !== 'fixture-agent-model')).toHaveLength(3)
  expect(billing.settlements.filter((one) => one.taskId === unknownId)).toHaveLength(0)
}, 20000)

it('同账号两个批次不能复用确认命令，冲突明确返回且第二批没有任务或预扣', async () => {
  const first = await plannedThree('#515184')
  const second = await plannedThree('#519784', false)
  const beforeReservations = billing.reservations.filter(
    (one) => one.model !== 'fixture-agent-model',
  ).length
  expect(beforeReservations).toBe(2)
  expect(first.initial.batch.submittedCount).toBe(2)
  expect(second.draft.batch).toMatchObject({
    status: 'draft',
    submittedCount: 0,
    confirmationRequired: true,
  })
  const conflict = await request(`${second.path}/confirm`, {
    ...second.command,
    commandId: first.command.commandId,
  })
  expect(conflict.status).toBe(409)
  expect(await conflict.json()).toEqual({ error: 'batch_version_conflict' })
  const unchanged = await (await request(second.path)).json()
  expect(unchanged.batch).toMatchObject({
    status: 'draft',
    version: 1,
    submittedCount: 0,
    confirmationRequired: true,
  })
  expect(unchanged.items.every((item: { execution?: unknown }) => !item.execution)).toBe(true)
  expect(billing.reservations.filter((one) => one.model !== 'fixture-agent-model')).toHaveLength(
    beforeReservations,
  )
  const firstAfter = await (await request(first.path)).json()
  expect(
    firstAfter.items.map((item: { execution?: { taskId: string } }) => item.execution?.taskId),
  ).toEqual(
    first.initial.items.map((item: { execution?: { taskId: string } }) => item.execution?.taskId),
  )
}, 20000)
