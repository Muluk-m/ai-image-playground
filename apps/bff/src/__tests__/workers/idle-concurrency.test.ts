import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'
import type { InternalChannel } from '../../lib/channels'
import { installRecordingTaskHooks } from '../helpers/privateOverlayStub'
import { forbidGlobalFetch } from '../helpers/upstreamStubs'

process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test-key'
process.env.DATABASE_URL = await resetTestDatabase('bff_idle_concurrency')
process.env.PORT = '0'
process.env.WORKER_OPENAI_CONCURRENCY = '4'
process.env.WORKER_GEMINI_CONCURRENCY = '4'
const billing = installRecordingTaskHooks()

const { close: closeDb, db, schema } = await import('../../db/client')
const { config } = await import('../../config')
const { claimTaskExecution } = await import('../../workers/task-execution')
const { selectRunnableTasks } = await import('../../workers/runnable-tasks')
const { _setChannelsForTesting } = await import('../../lib/channels')

const STARTER = 'starter-user'
const STANDARD = 'standard-user'
const FREE = 'free-user'
const OTHERS = ['other-1', 'other-2', 'other-3']

const vertexChannel: InternalChannel = {
  id: 'vertex-images',
  kind: 'gemini-queue',
  label: 'Vertex AI',
  baseUrl: 'https://vertex.invalid/v1',
  auth: { type: 'bearer', secretRef: 'VERTEX_API_KEY', secret: 'vertex-test-key' },
  allowedPaths: [],
  models: ['gemini-3.1-flash-lite-image', 'gemini-3-pro-image'].map((id) => ({
    id,
    label: id,
    capabilities: ['generate'],
  })),
  defaults: { apiMode: 'images', timeout: 600 },
  modelMaxConcurrency: { 'gemini-3.1-flash-lite-image': 2, 'gemini-3-pro-image': 2 },
} as unknown as InternalChannel

let restoreFetch: () => void
const claimed: Array<{ release(): void }> = []

beforeEach(async () => {
  billing.reset()
  // 入门：保证 1、空闲 2；标准：保证 2、不配空闲；无订阅：保证 1、不配空闲。
  billing.entitlementFor = (userId) =>
    userId === STARTER
      ? { guaranteed: 1, idle: 2 }
      : userId === STANDARD
        ? { guaranteed: 2, idle: 2 }
        : { guaranteed: 1, idle: 1 }
  config.worker.idleConcurrencyEnabled = true
  _setChannelsForTesting([vertexChannel])
  restoreFetch = forbidGlobalFetch()
  await db.delete(schema.tasks)
  await db.delete(schema.users)
  const now = Date.now()
  await db.insert(schema.users).values(
    [STARTER, STANDARD, FREE, ...OTHERS].map((id) => ({
      id,
      username: id,
      password_hash: 'test',
      created_at: now,
      updated_at: now,
    })),
  )
})

afterEach(() => {
  for (const one of claimed.splice(0)) one.release()
  config.worker.idleConcurrencyEnabled = false
  _setChannelsForTesting([])
  restoreFetch()
})

afterAll(async () => {
  await closeDb()
})

let seq = 0
async function queue(
  userId: string,
  values: Partial<typeof schema.tasks.$inferInsert> = {},
): Promise<string> {
  seq += 1
  const id = `${userId}-${String(seq).padStart(4, '0')}`
  await db.insert(schema.tasks).values({
    id,
    user_id: userId,
    provider: 'openai-compat',
    model: 'test-model',
    status: 'queued',
    request_payload: { prompt: id, device_id: 'idle-device' },
    submitted_at: seq,
    ...values,
  })
  return id
}

async function running(userId: string, values: Partial<typeof schema.tasks.$inferInsert> = {}) {
  return queue(userId, {
    status: 'in_progress',
    started_at: Date.now(),
    execution_token: 'elsewhere',
    lease_expires_at: Date.now() + 60_000,
    ...values,
  })
}

async function claim(id: string) {
  const execution = await claimTaskExecution(id)
  if (execution) claimed.push(execution)
  return execution
}

async function status(id: string) {
  const [row] = await db
    .select({ status: schema.tasks.status })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, id))
  return row?.status
}

describe('入门版空闲时可用并发', () => {
  it('服务器空闲时入门用户同时跑 2 个，第 2 个标记为弹性名额，第 3 个不放', async () => {
    const ids = [await queue(STARTER), await queue(STARTER), await queue(STARTER)]
    const selected = await selectRunnableTasks('openai-compat', 4, Date.now())
    expect(selected.map((task) => task.id)).toEqual([ids[0]!, ids[1]!])

    const first = await claim(ids[0]!)
    const second = await claim(ids[1]!)
    expect(first?.idleSlot).toBe(false)
    expect(second?.idleSlot).toBe(true)
    expect(await claim(ids[2]!)).toBeNull()
    expect(await status(ids[2]!)).toBe('queued')
  })

  it('有别人排队时入门用户只跑 1 个，别人的任务先选、先认领', async () => {
    await running(STARTER)
    const starterNext = await queue(STARTER)
    const other = await queue('other-1')

    const selected = await selectRunnableTasks('openai-compat', 4, Date.now())
    expect(selected.map((task) => task.id)).toEqual([other])
    // 即使绕过选择直接认领，只要别人还在排队就不放弹性名额。
    expect(await claim(starterNext)).toBeNull()

    expect(await claim(other)).not.toBeNull()
    // 别人的任务跑起来、不再有人排队后，余量够就放行。
    const later = await claim(starterNext)
    expect(later?.idleSlot).toBe(true)
  })

  it('标准用户自己的保证并发排在入门用户的弹性名额前面', async () => {
    await running(STARTER)
    const starterNext = await queue(STARTER)
    await running(STANDARD)
    const standardSecond = await queue(STANDARD)

    const selected = await selectRunnableTasks('openai-compat', 4, Date.now())
    expect(selected.map((task) => task.id)).toEqual([standardSecond])
    expect(await claim(starterNext)).toBeNull()
  })

  it('无订阅（没配空闲并发）的账号不享受弹性名额', async () => {
    const ids = [await queue(FREE), await queue(FREE)]
    const selected = await selectRunnableTasks('openai-compat', 4, Date.now())
    expect(selected.map((task) => task.id)).toEqual([ids[0]!])
    expect(await claim(ids[0]!)).not.toBeNull()
    expect(await claim(ids[1]!)).toBeNull()
  })

  it('总开关关着时行为与以前一样：入门用户只跑 1 个', async () => {
    config.worker.idleConcurrencyEnabled = false
    const ids = [await queue(STARTER), await queue(STARTER)]
    const selected = await selectRunnableTasks('openai-compat', 4, Date.now())
    expect(selected.map((task) => task.id)).toEqual([ids[0]!])
    expect(await claim(ids[0]!)).not.toBeNull()
    expect(await claim(ids[1]!)).toBeNull()
  })

  it('全局正在跑的数 +1 超过 worker 并发上限时不放行', async () => {
    await running(STARTER)
    for (const user of OTHERS) await running(user)
    const starterNext = await queue(STARTER)
    expect(await selectRunnableTasks('openai-compat', 4, Date.now())).toEqual([])
    expect(await claim(starterNext)).toBeNull()
  })

  it('模型通道上限（Vertex 每个模型 2）用满时不放行，别的模型照常', async () => {
    const lite = 'gemini-3.1-flash-lite-image'
    await running(STARTER, { provider: 'gemini', model: lite })
    await running('other-1', { provider: 'gemini', model: lite })
    const sameModel = await queue(STARTER, { provider: 'gemini', model: lite })
    expect(await selectRunnableTasks('gemini', 4, Date.now())).toEqual([])
    expect(await claim(sameModel)).toBeNull()

    await db
      .update(schema.tasks)
      .set({ model: 'gemini-3-pro-image' })
      .where(eq(schema.tasks.id, sameModel))
    const other = await claim(sameModel)
    expect(other?.idleSlot).toBe(true)
  })

  it('同一入门用户三个认领同时来，只按空闲并发上限放 2 个', async () => {
    billing.entitlementFor = () => ({ guaranteed: 1, idle: 3 })
    await running(STARTER)
    await running('other-1')
    // 全局上限 4：已跑 2，还剩 2 个余量，但空闲并发 3 只允许再多 2 个；三个同时抢只能拿到 2 个，
    // 第三个因账号空闲并发上限被拒。
    const ids = [await queue(STARTER), await queue(STARTER), await queue(STARTER)]
    const results = await Promise.all(ids.map((id) => claim(id)))
    expect(results.filter(Boolean)).toHaveLength(2)
    expect(results.filter(Boolean).every((one) => one?.idleSlot)).toBe(true)
  })

  it('多个调度方同时放弹性名额不超过全局余量', async () => {
    billing.entitlementFor = (userId) =>
      userId === STARTER ? { guaranteed: 1, idle: 4 } : { guaranteed: 1, idle: 1 }
    await running(STARTER)
    await running('other-1')
    await running('other-2')
    // 全局只剩 1 个位，三个弹性认领同时来，只能放 1 个。
    const ids = [await queue(STARTER), await queue(STARTER), await queue(STARTER)]
    const results = await Promise.all(ids.map((id) => claim(id)))
    expect(results.filter(Boolean)).toHaveLength(1)
    const [row] = await db
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(eq(schema.tasks.status, 'in_progress'))
    expect(row).toBeDefined()
  })
})
