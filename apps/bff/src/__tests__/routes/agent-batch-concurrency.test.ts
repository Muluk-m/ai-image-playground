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

process.env.DATABASE_URL = await resetTestDatabase('bff_agent_batch_concurrency')
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
    id: 'batch-concurrency-owner-a',
    username: 'batch-concurrency-owner-a',
    password_hash: 'fixture',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
  cookie = `${USER_SESSION_COOKIE}=${await db.transaction((tx) => createUserSession('batch-concurrency-owner-a', tx))}`
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

it('跨批入队窗口与实际运行并发分别受限，同账号两批不会挤掉另一个账号', async () => {
  billing.answer = { kind: 'reserved', credits: 7 }
  billing.settledCredits = 7
  billing.concurrencyLimit = 2
  const now = Date.now()
  const secondUser = 'batch-concurrency-owner-b'
  await db.insert(schema.users).values({
    id: secondUser,
    username: secondUser,
    password_hash: 'fixture',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
  const secondCookie = `${USER_SESSION_COOKIE}=${await db.transaction((tx) => createUserSession(secondUser, tx))}`
  const expected = new Map<string, { taskId: string; userId: string; batchId: string }>()
  const batches: {
    path: string
    conversationId: string
    batchId: string
    requestCookie: string
  }[] = []
  const modelCalls: AgentCall[] = []
  for (const [label, userId, requestCookie, background] of [
    ['a-one', 'batch-concurrency-owner-a', cookie, '#123456'],
    ['a-two', 'batch-concurrency-owner-a', cookie, '#234567'],
    ['b-one', secondUser, secondCookie, '#345678'],
  ]) {
    const mediaId = await upload(background!, requestCookie!)
    const { conversation } = await (
      await request('agent/conversations', { deviceId: DEVICE }, 'POST', requestCookie)
    ).json()
    setAgentFetchForTesting(
      scriptedAgentFetch(modelCalls, [
        () =>
          toolCallCompletion({
            id: `plan-${label}`,
            name: 'planImageBatch',
            args: {
              title: label,
              rule: '三项独立编辑',
              items: [0, 1, 2].map((number) => ({
                key: `${label}-${number}`,
                imageIds: ['original'],
                prompt: `批号:${label} 编号:${number} 背景改白`,
                dependencies: [],
              })),
            },
          }),
        () => completionStream('请确认三项'),
      ]),
    )
    const planned = await request(
      `agent/conversations/${conversation.id}/turns`,
      {
        deviceId: DEVICE,
        text: '拟三个独立编辑计划',
        references: [{ imageId: 'original', mediaId }],
      },
      'POST',
      requestCookie,
    )
    expect(planned.status).toBe(200)
    await planned.text()
    await waitFor(async () => {
      const [lease] = await db
        .select()
        .from(schema.agent_executions)
        .where(eq(schema.agent_executions.conversation_id, conversation.id))
      return lease?.state !== 'running'
    })
    const listed = await (
      await request(
        `agent/conversations/${conversation.id}/batches`,
        undefined,
        'GET',
        requestCookie,
      )
    ).json()
    expect(listed.batches).toHaveLength(1)
    const batchId = listed.batches[0].id
    const path = `agent/batches/${batchId}`
    const draft = await (await request(path, undefined, 'GET', requestCookie)).json()
    const command = {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      expectedDigest: draft.batch.digest,
      deviceId: DEVICE,
    }
    const confirmedResponse = await request(`${path}/confirm`, command, 'POST', requestCookie)
    expect(confirmedResponse.status).toBe(200)
    const confirmed = await confirmedResponse.json()
    expect(confirmed.batch.submittedCount).toBe(3)
    const repeated = await (await request(`${path}/confirm`, command, 'POST', requestCookie)).json()
    expect(
      repeated.items.map((item: { execution: { taskId: string } }) => item.execution.taskId),
    ).toEqual(
      confirmed.items.map((item: { execution: { taskId: string } }) => item.execution.taskId),
    )
    for (const item of confirmed.items)
      expected.set(item.key, { taskId: item.execution.taskId, userId: userId!, batchId })
    batches.push({ path, conversationId: conversation.id, batchId, requestCookie: requestCookie! })
  }
  expect(expected.size).toBe(9)
  expect(billing.reservations.filter((one) => one.model !== 'fixture-agent-model')).toHaveLength(9)
  const calls: string[] = []
  const releases = new Map<string, () => void>()
  const active = new Set<string>()
  const observed: { total: number; perUser: number[] }[] = []
  let releaseAll = false
  const output = await sharp({
    create: { width: 8, height: 6, channels: 4, background: '#ffffff' },
  })
    .png()
    .toBuffer()
  setUpstreamFetchForTesting(async (_url, init) => {
    const prompt = String((init!.body as FormData).get('prompt'))
    const match = /批号:(a-one|a-two|b-one) 编号:(\d)/.exec(prompt)
    const key = match ? `${match[1]}-${match[2]}` : ''
    expect(expected.has(key)).toBe(true)
    calls.push(key)
    active.add(key)
    const counts = new Map<string, number>()
    for (const one of active) {
      const userId = expected.get(one)!.userId
      counts.set(userId, (counts.get(userId) ?? 0) + 1)
    }
    observed.push({ total: active.size, perUser: [...counts.values()] })
    try {
      if (!releaseAll) await new Promise<void>((resolve) => releases.set(key, resolve))
      return Response.json({ data: [{ b64_json: output.toString('base64') }] })
    } finally {
      active.delete(key)
    }
  })
  const worker = new TaskScheduler({ pollIntervalMs: 10, concurrency: { 'openai-compat': 3 } })
  const running = () =>
    db
      .select({ userId: schema.tasks.user_id })
      .from(schema.tasks)
      .where(and(eq(schema.tasks.kind, 'queue'), eq(schema.tasks.status, 'in_progress')))
  try {
    worker.start()
    await waitFor(() => calls.length === 3, 10000)
    const initial = await running()
    expect(initial).toHaveLength(3)
    expect(initial.filter((row) => row.userId === 'batch-concurrency-owner-a')).toHaveLength(2)
    expect(initial.filter((row) => row.userId === secondUser)).toHaveLength(1)
    // Nine admitted tasks are valid: each independent batch has a window of three.
    for (const batch of batches) {
      const read = await (await request(batch.path, undefined, 'GET', batch.requestCookie)).json()
      expect(read.batch.submittedCount).toBe(3)
    }
    releases.get(calls[0]!)!()
    await waitFor(() => calls.length === 4, 10000)
    const afterOne = await running()
    expect(afterOne).toHaveLength(3)
    expect(
      afterOne.filter((row) => row.userId === 'batch-concurrency-owner-a').length,
    ).toBeLessThanOrEqual(2)
    expect(afterOne.filter((row) => row.userId === secondUser).length).toBeLessThanOrEqual(2)
    expect(new Set(calls).size).toBe(4)
    // The concurrency assertions are complete. Drain output archival one at a time so this
    // test does not depend on the separate media-processing busy retry's 60-second backoff.
    const released = new Set([calls[0]!])
    while (released.size < expected.size) {
      await waitFor(() => calls.some((key) => !released.has(key)), 10000)
      const key = calls.find((candidate) => !released.has(candidate))!
      released.add(key)
      releases.get(key)!()
      await waitFor(async () => {
        const [task] = await db
          .select({ status: schema.tasks.status })
          .from(schema.tasks)
          .where(eq(schema.tasks.id, expected.get(key)!.taskId))
        return task?.status === 'completed'
      }, 10000)
    }
    await waitFor(async () => {
      const states = await Promise.all(
        batches.map(
          async (batch) =>
            (await (await request(batch.path, undefined, 'GET', batch.requestCookie)).json()).batch
              .status,
        ),
      )
      return states.every((state) => state === 'closed')
    }, 20000)
    await waitFor(async () => {
      const notices = await db
        .select()
        .from(schema.agent_inbox)
        .where(eq(schema.agent_inbox.kind, 'task_result'))
      return notices.length === 3
    }, 10000)
    expect(calls).toHaveLength(9)
    expect(new Set(calls)).toEqual(new Set(expected.keys()))
    expect(Math.max(...observed.map((one) => one.total))).toBeLessThanOrEqual(3)
    expect(Math.max(...observed.flatMap((one) => one.perUser))).toBeLessThanOrEqual(2)
    expect(billing.reservations.filter((one) => one.model !== 'fixture-agent-model')).toHaveLength(
      9,
    )
    expect(modelCalls).toHaveLength(6)
  } finally {
    releaseAll = true
    for (const release of releases.values()) release()
    worker.stop()
    expect(await worker.waitForIdle(10000)).toBe(true)
  }
}, 60000)
