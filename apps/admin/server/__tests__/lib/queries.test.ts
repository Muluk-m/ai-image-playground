import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { unlinkSync } from 'node:fs'

const TEST_DB = './artifacts/test-admin-queries.sqlite'
try {
  unlinkSync(TEST_DB)
  unlinkSync(`${TEST_DB}-wal`)
  unlinkSync(`${TEST_DB}-shm`)
} catch {}

process.env.ADMIN_PASSWORD = 'test-pass-1234'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.DATABASE_URL = TEST_DB
process.env.BFF_INTERNAL_URL = 'http://localhost:9999'
process.env.PORT = '0'

const { runMigrations, createDb } = await import('@image-playground/db')
runMigrations(TEST_DB)

// seed 写入数据
const writer = createDb(TEST_DB)
const now = Date.now()
const dayMs = 24 * 60 * 60 * 1000
function seedTask(args: {
  id: string
  device: string
  provider: 'openai-compat' | 'gemini'
  model: string
  status: 'completed' | 'failed' | 'queued'
  daysAgo: number
}) {
  writer.db
    .insert(writer.schema.tasks)
    .values({
      id: args.id,
      provider: args.provider,
      model: args.model,
      status: args.status,
      request_payload: { prompt: 'p', device_id: args.device } as never,
      submitted_at: now - args.daysAgo * dayMs,
      ...(args.status === 'completed' ? { completed_at: now - args.daysAgo * dayMs + 1000 } : {}),
    })
    .run()
}

// dev-A 设备：今天 3 个 task（2 完成 1 失败）
seedTask({
  id: 't1',
  device: 'dev-A-aaaa',
  provider: 'openai-compat',
  model: 'gpt-image-2',
  status: 'completed',
  daysAgo: 0,
})
seedTask({
  id: 't2',
  device: 'dev-A-aaaa',
  provider: 'openai-compat',
  model: 'gpt-image-2',
  status: 'completed',
  daysAgo: 0,
})
seedTask({
  id: 't3',
  device: 'dev-A-aaaa',
  provider: 'gemini',
  model: 'gemini-3-pro',
  status: 'failed',
  daysAgo: 0,
})
// dev-B 设备：5 天前 1 个 task
seedTask({
  id: 't4',
  device: 'dev-B-bbbb',
  provider: 'gemini',
  model: 'gemini-3-pro',
  status: 'completed',
  daysAgo: 5,
})
// dev-OLD：30 天前 1 个 task（range=7d 不应包含）
seedTask({
  id: 't5',
  device: 'dev-OLD-aa',
  provider: 'openai-compat',
  model: 'gpt-image-2',
  status: 'completed',
  daysAgo: 30,
})

const { listDevices, getDeviceDetail, getTask } = await import('../../lib/queries')

describe('listDevices', () => {
  it('range=7d 不包含 30 天前的 dev-OLD', async () => {
    const result = await listDevices('7d', 'last_seen')
    const ids = result.devices.map((d) => d.device_id)
    expect(ids).toContain('dev-A-aaaa')
    expect(ids).toContain('dev-B-bbbb')
    expect(ids).not.toContain('dev-OLD-aa')
    expect(result.truncated).toBe(false)
  })

  it('sort=last_seen：dev-A（今天）在 dev-B（5 天前）前面', async () => {
    const result = await listDevices('7d', 'last_seen')
    const idxA = result.devices.findIndex((d) => d.device_id === 'dev-A-aaaa')
    const idxB = result.devices.findIndex((d) => d.device_id === 'dev-B-bbbb')
    expect(idxA).toBeLessThan(idxB)
  })

  it('dev-A 的聚合：total=3 ok=2 fail=1', async () => {
    const result = await listDevices('7d', 'last_seen')
    const devA = result.devices.find((d) => d.device_id === 'dev-A-aaaa')!
    expect(devA.total).toBe(3)
    expect(devA.ok_count).toBe(2)
    expect(devA.fail_count).toBe(1)
    expect(devA.models).toEqual(expect.arrayContaining(['gpt-image-2', 'gemini-3-pro']))
  })
})

describe('getDeviceDetail', () => {
  it('dev-A 详情 task 列表含 3 条 + 不含 result_payload 字段', async () => {
    const detail = await getDeviceDetail('dev-A-aaaa', '7d')
    expect(detail.device!.device_id).toBe('dev-A-aaaa')
    expect(detail.tasks).toHaveLength(3)
    expect(detail.truncated).toBe(false)
    // 字段白名单：不含 result_payload
    expect((detail.tasks[0] as unknown as Record<string, unknown>).result_payload).toBeUndefined()
  })

  it('不存在的设备返回空 tasks', async () => {
    const detail = await getDeviceDetail('dev-NOPE', '7d')
    expect(detail.device).toBeNull()
    expect(detail.tasks).toEqual([])
  })
})

describe('getTask', () => {
  it('返回 task 全字段（含 result_meta）剔除 result_payload', async () => {
    const task = await getTask('t1')
    expect(task).not.toBeNull()
    expect(task!.id).toBe('t1')
    expect((task as unknown as Record<string, unknown>).result_payload).toBeUndefined()
    expect(task!.result_meta).toBeDefined()
  })

  it('不存在的 task → null', async () => {
    const task = await getTask('nope')
    expect(task).toBeNull()
  })
})

afterAll(() => writer.sqlite.close())
