import { afterAll, describe, expect, it } from 'bun:test'
import { createDb } from '@image-playground/db'
import { resetTestDatabase } from '@image-playground/db/testing'

const TEST_DB = await resetTestDatabase('admin_queries')
process.env.ADMIN_PASSWORD = 'test-pass-1234'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.DATABASE_URL = TEST_DB
process.env.BFF_INTERNAL_URL = 'http://127.0.0.1:39999'
process.env.PORT = '0'

const writer = createDb(TEST_DB)
const now = Date.now()
const dayMs = 24 * 60 * 60 * 1000
const seedTask = (
  id: string,
  device: string,
  provider: 'openai-compat' | 'gemini',
  model: string,
  status: 'completed' | 'failed' | 'queued',
  daysAgo: number,
) => ({
  id,
  provider,
  model,
  status,
  request_payload: { prompt: 'p', device_id: device },
  submitted_at: now - daysAgo * dayMs,
  ...(status === 'completed' ? { completed_at: now - daysAgo * dayMs + 1000 } : {}),
})

await writer.db.insert(writer.schema.tasks).values([
  seedTask('t1', 'dev-A-aaaa', 'openai-compat', 'gpt-image-2', 'completed', 0),
  seedTask('t2', 'dev-A-aaaa', 'openai-compat', 'gpt-image-2', 'completed', 0),
  seedTask('t3', 'dev-A-aaaa', 'gemini', 'gemini-3-pro', 'failed', 0),
  seedTask('t4', 'dev-B-bbbb', 'gemini', 'gemini-3-pro', 'completed', 5),
  seedTask('t5', 'dev-OLD-aa', 'openai-compat', 'gpt-image-2', 'completed', 30),
  ...Array.from({ length: 150 }, (_, index) => ({
    id: `pg-${String(index).padStart(3, '0')}`,
    provider: 'openai-compat' as const,
    model: 'gpt-image-2',
    status: 'completed' as const,
    request_payload: { prompt: `prompt-${index}`, n: 2, device_id: 'dev-PAGE-xx' },
    submitted_at: now - index * 1000,
    completed_at: now - index * 1000 + 500,
  })),
  {
    id: 'big-1',
    provider: 'openai-compat',
    model: 'gpt-image-2',
    status: 'completed',
    request_payload: {
      prompt: 'a big one',
      n: 1,
      device_id: 'dev-BIG-xx',
      extra: { blob: 'BIGIMAGEDATA'.repeat(10_000) },
    },
    submitted_at: now,
    completed_at: now + 1000,
  },
])

// Dynamic import keeps environment setup ahead of Admin configuration capture.
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
  it('dev-A 详情 task 列表含 3 条；瘦身后含 prompt、不含 request_payload/result_payload', async () => {
    const detail = await getDeviceDetail('dev-A-aaaa', '7d')
    expect(detail.device!.device_id).toBe('dev-A-aaaa')
    expect(detail.tasks).toHaveLength(3)
    expect(detail.nextCursor).toBeNull()
    // 列表项预抽 prompt（seed 用 prompt:'p'）
    expect(detail.tasks[0]?.prompt).toBe('p')
    // 字段白名单：不再回传整坨 request_payload，也没有 result_payload
    const first = detail.tasks[0] as unknown as Record<string, unknown>
    expect(first.request_payload).toBeUndefined()
    expect(first.result_payload).toBeUndefined()
  })

  it('不存在的设备返回空 tasks', async () => {
    const detail = await getDeviceDetail('dev-NOPE', '7d')
    expect(detail.device).toBeNull()
    expect(detail.tasks).toEqual([])
    expect(detail.nextCursor).toBeNull()
  })

  it('列表项剔除 input_images base64：响应体积保持极小（拉取慢的根因修复）', async () => {
    const detail = await getDeviceDetail('dev-BIG-xx', '30d')
    expect(detail.tasks).toHaveLength(1)
    const json = JSON.stringify(detail.tasks[0])
    // 120KB 的 base64 绝不能出现在列表响应里
    expect(json).not.toContain('BIGIMAGEDATA')
    expect(json.length).toBeLessThan(2000)
    // 但 prompt/n 正常预抽
    expect(detail.tasks[0]?.prompt).toBe('a big one')
    expect(detail.tasks[0]?.n).toBe(1)
  })
})

describe('getDeviceDetail 分页', () => {
  it('首页返回 PAGE_SIZE(100) 条 + nextCursor 非空 + 设备聚合 total=150', async () => {
    const p1 = await getDeviceDetail('dev-PAGE-xx', '30d')
    expect(p1.tasks).toHaveLength(100)
    expect(p1.nextCursor).not.toBeNull()
    expect(p1.tasks[0]?.id).toBe('pg-000')
    expect(p1.device!.total).toBe(150)
    // 瘦身后列表项含 prompt/n
    expect(p1.tasks[0]?.prompt).toBe('prompt-0')
    expect(p1.tasks[0]?.n).toBe(2)
  })

  it('第二页用 cursor 拿剩余 50 条、无重叠、device 为 null、nextCursor 收敛到 null', async () => {
    const p1 = await getDeviceDetail('dev-PAGE-xx', '30d')
    const p2 = await getDeviceDetail('dev-PAGE-xx', '30d', p1.nextCursor!)
    expect(p2.tasks).toHaveLength(50)
    expect(p2.nextCursor).toBeNull()
    expect(p2.device).toBeNull()
    expect(p2.tasks[0]?.id).toBe('pg-100')
    const ids1 = new Set(p1.tasks.map((t) => t.id))
    expect(p2.tasks.every((t) => !ids1.has(t.id))).toBe(true)
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

afterAll(async () => {
  await writer.close()
})
