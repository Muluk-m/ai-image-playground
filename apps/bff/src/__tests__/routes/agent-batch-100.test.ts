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

process.env.DATABASE_URL = await resetTestDatabase('bff_agent_batch_100')
process.env.PORT = '0'
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
    id: 'batch-100-owner',
    username: 'batch-100-owner',
    password_hash: 'fixture',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
  cookie = `${USER_SESSION_COOKIE}=${await db.transaction((tx) => createUserSession('batch-100-owner', tx))}`
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

it('100项按窗口执行，暂停恢复不重扣，99项完成和1项未知在核查后仅聚合一次', async () => {
  billing.answer = { kind: 'reserved', credits: 7 }
  billing.settledCredits = 7
  const inputs: { key: string; mediaId: string; sha256: string }[] = []
  for (let i = 0; i < 100; i++) {
    const bytes = await sharp({
      create: { width: 8, height: 6, channels: 4, background: { r: i, g: 100, b: 200, alpha: 1 } },
    })
      .png()
      .toBuffer()
    inputs.push({
      key: String(i).padStart(3, '0'),
      mediaId: await upload(bytes),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
  }
  const { conversation } = await (await request('agent/conversations', { deviceId: DEVICE })).json()
  const modelCalls: AgentCall[] = []
  setAgentFetchForTesting(
    scriptedAgentFetch(modelCalls, [
      () =>
        toolCallCompletion({
          id: 'hundred-batch',
          name: 'planImageBatch',
          args: {
            title: '100张分别换白底',
            rule: '完整范围每张一项',
            items: inputs.map(({ key }) => ({
              key,
              imageIds: [key],
              prompt: `编号:${key} 原图换成白底`,
              dependencies: [],
            })),
          },
        }),
      () => completionStream('请确认100项完整范围'),
      () => completionStream('99项成功，1项已核实没有结果，明细保留。'),
    ]),
  )
  const planning = await request(`agent/conversations/${conversation.id}/turns`, {
    deviceId: DEVICE,
    text: '按附件顺序为100张分别拟白底编辑计划，不遗漏图片',
    references: inputs.map(({ key, mediaId }) => ({ imageId: key, mediaId })),
  })
  if (planning.status !== 200)
    throw new Error(`100-item planning HTTP ${planning.status}: ${await planning.text()}`)
  expect(planning.status).toBe(200)
  await planning.text()
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
  expect(draft.batch.itemCount).toBe(100)
  expect(draft.items.map((item: { key: string }) => item.key)).toEqual(inputs.map((one) => one.key))
  const command = {
    commandId: 'hundred-confirm',
    expectedVersion: 1,
    expectedDigest: draft.batch.digest,
    deviceId: DEVICE,
  }
  const first = await (await request(`${path}/confirm`, command)).json()
  expect(first.batch.submittedCount).toBe(3)
  expect((await (await request(`${path}/confirm`, command)).json()).batch.submittedCount).toBe(3)
  const actual: { key: string; sha256: string }[] = []
  const windowSizes: number[] = []
  const output = await sharp({
    create: { width: 8, height: 6, channels: 4, background: '#ffffff' },
  })
    .png()
    .toBuffer()
  setUpstreamFetchForTesting(async (_url, init) => {
    const form = init!.body as FormData
    const key = /编号:(\d{3})/.exec(String(form.get('prompt')))?.[1] ?? ''
    const image = form.get('image[]') ?? form.get('image')
    actual.push({
      key,
      sha256:
        image instanceof Blob
          ? createHash('sha256')
              .update(new Uint8Array(await image.arrayBuffer()))
              .digest('hex')
          : '',
    })
    const tasks = await db
      .select({ status: schema.tasks.status })
      .from(schema.agent_batch_attempts)
      .innerJoin(schema.tasks, eq(schema.tasks.id, schema.agent_batch_attempts.task_id))
      .where(eq(schema.agent_batch_attempts.batch_id, draft.batch.id))
    windowSizes.push(
      tasks.filter((task) => ['queued', 'in_progress', 'reconciling'].includes(task.status)).length,
    )
    if (key === '099') throw new Error('connection lost after upstream acceptance')
    return Response.json({ data: [{ b64_json: output.toString('base64') }] })
  })
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let preparingNext = false
  const [fourthOriginal] = await db
    .select({ key: schema.media_objects.object_key })
    .from(schema.media_objects)
    .where(eq(schema.media_objects.id, inputs[3]!.mediaId))
  expect(fourthOriginal?.key).toBeTruthy()
  storage.beforeRead = async (key) => {
    if (key !== fourthOriginal!.key) return
    preparingNext = true
    await gate
  }
  let worker = new TaskScheduler({ pollIntervalMs: 10, concurrency: { 'openai-compat': 1 } })
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
  try {
    worker.start()
    await waitFor(() => preparingNext, 10000)
    const pauseResponse = await request(`${path}/pause`, {
      commandId: 'hundred-pause',
      expectedVersion: 1,
    })
    expect(pauseResponse.status).toBe(200)
    const paused = await pauseResponse.json()
    expect(paused.batch).toMatchObject({ status: 'paused', submittedCount: 3 })
    storage.beforeRead = undefined
    release()
    expect(await worker.waitForIdle(10000)).toBe(true)
    expect((await (await request(path)).json()).batch.submittedCount).toBe(3)
    expect((await (await request(`${path}/confirm`, command)).json()).batch.status).toBe('paused')
    expect(await wakes()).toHaveLength(0)
    worker.stop()
    expect(await worker.waitForIdle(10000)).toBe(true)
    worker = new TaskScheduler({ pollIntervalMs: 10, concurrency: { 'openai-compat': 1 } })
    const resumeResponse = await request(`${path}/resume`, {
      ...command,
      commandId: 'hundred-resume',
    })
    expect(resumeResponse.status).toBe(200)
    worker.start()
    await waitFor(() => actual.length === 100, 90000)
    await waitFor(async () => {
      const current = await (await request(path)).json()
      return (
        current.items.filter(
          (item: { execution?: { status: string } }) => item.execution?.status === 'completed',
        ).length === 99 && current.items[99].execution?.status === 'reconciling'
      )
    }, 10000)
    const unknown = await (await request(path)).json()
    expect(unknown.batch).toMatchObject({
      status: 'running',
      submittedCount: 100,
      actualCredits: 693,
    })
    expect(await wakes()).toHaveLength(0)
    expect(modelCalls).toHaveLength(2)
    expect(Math.max(...windowSizes)).toBeLessThanOrEqual(3)
    expect(new Set(actual.map((one) => one.key)).size).toBe(100)
    expect(actual.slice().sort((a, b) => a.key.localeCompare(b.key))).toEqual(
      inputs.map(({ key, sha256 }) => ({ key, sha256 })),
    )
    expect(billing.reservations.filter((one) => one.model !== 'fixture-agent-model')).toHaveLength(
      100,
    )
    const unknownId = unknown.items[99].execution.taskId
    expect(billing.settlements.filter((one) => one.taskId === unknownId)).toHaveLength(0)
    const retry = await request(`${path}/retry-quote`, {
      commandId: 'unknown-retry-forbidden',
      expectedVersion: 1,
      itemKeys: ['099'],
    })
    expect(retry.status).toBe(409)
    await runTask(unknownId)
    expect(actual).toHaveLength(100)
    // Page through a fixed version while the batch stays running; no missing/duplicated item keys.
    const keys: string[] = []
    let cursor: string | null = null
    do {
      const page = await (
        await request(`${path}?limit=17${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      ).json()
      keys.push(...page.items.map((item: { key: string }) => item.key))
      cursor = page.nextCursor
    } while (cursor)
    expect(keys).toEqual(inputs.map((one) => one.key))
    const reconcile = () =>
      app.handle(
        new Request(`http://localhost/internal/admin/tasks/${unknownId}/reconciliation`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer batch-reconciliation-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            commandId: 'hundred-no-result',
            operatorId: 'fixture-operator',
            action: 'confirm_no_result',
            evidence: 'Mock provider audit confirms no output for item099.',
          }),
        }),
      )
    expect((await reconcile()).status).toBe(200)
    expect((await reconcile()).status).toBe(200)
    await waitFor(async () => (await wakes()).length === 1, 10000)
    const completed = await (await request(path)).json()
    expect(completed.batch).toMatchObject({
      status: 'closed',
      submittedCount: 100,
      actualCredits: 693,
    })
    expect(completed.items[99].execution).toMatchObject({ status: 'failed', actualCredits: 0 })
    expect(billing.settlements.filter((one) => one.taskId === unknownId)).toHaveLength(1)
    expect(actual).toHaveLength(100)
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
    }, 10000)
    expect(modelCalls).toHaveLength(3)
    await request(`${path}/confirm`, command)
    expect(await wakes()).toHaveLength(1)
    expect(billing.reservations.filter((one) => one.model !== 'fixture-agent-model')).toHaveLength(
      100,
    )
  } finally {
    storage.beforeRead = undefined
    release()
    worker.stop()
    expect(await worker.waitForIdle(10000)).toBe(true)
  }
}, 120000)
