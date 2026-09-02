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
  upstream_invocation_count: id === 't1' ? 2 : 0,
  ...(status === 'completed' ? { completed_at: now - daysAgo * dayMs + 1000 } : {}),
})

await writer.db.insert(writer.schema.tasks).values([
  seedTask('t1', 'dev-A-aaaa', 'openai-compat', 'gpt-image-2', 'completed', 0),
  seedTask('t2', 'dev-A-aaaa', 'openai-compat', 'gpt-image-2', 'completed', 0),
  {
    ...seedTask('t3', 'dev-A-aaaa', 'gemini', 'gemini-3-pro', 'failed', 0),
    error_message: 'Upstream request failed',
    upstream_status: 502,
    upstream_body: '{"error":{"message":"Upstream request failed","type":"upstream_error"}}',
  },
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
    upstream_invocation_count: 3,
  })),
  {
    id: 'multiplier-4',
    provider: 'openai-compat',
    model: 'normalized-multiplier',
    status: 'completed',
    request_payload: { prompt: 'four images', n: 4, device_id: 'dev-MULTIPLIER' },
    submitted_at: now,
    completed_at: now + 1000,
    upstream_invocation_count: 4,
  },
  {
    id: 'multiplier-1',
    provider: 'openai-compat',
    model: 'normalized-multiplier',
    status: 'completed',
    request_payload: { prompt: 'one image', n: 1, device_id: 'dev-MULTIPLIER' },
    submitted_at: now,
    completed_at: now + 1000,
    upstream_invocation_count: 1,
  },
  {
    // 60 天前：任何时间窗都覆盖不到，用来钉住「用户详情看全量历史」
    id: 'hist-60d',
    provider: 'openai-compat',
    model: 'gpt-image-2',
    status: 'completed',
    request_payload: { prompt: 'ancient history', n: 1, device_id: 'dev-HIST-xx' },
    submitted_at: now - 60 * dayMs,
    completed_at: now - 60 * dayMs + 1000,
    upstream_invocation_count: 1,
  },
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
    upstream_invocation_count: 4,
  },
])
await writer.db.insert(writer.schema.users).values([
  {
    id: 'user-page',
    username: 'page-user',
    password_hash: 'argon-hash',
    status: 'active',
    created_at: now,
    updated_at: now,
  },
  {
    id: 'user-history',
    username: 'history-user',
    password_hash: 'argon-hash',
    status: 'active',
    created_at: now - 90 * dayMs,
    updated_at: now - 90 * dayMs,
  },
])
await writer.client`UPDATE tasks SET user_id = 'user-page' WHERE id LIKE 'pg-%' OR id = 't3'`
await writer.client`UPDATE tasks SET user_id = 'user-history' WHERE id = 'hist-60d'`

// Dynamic import keeps environment setup ahead of Admin configuration capture.
const { listDevices, getDeviceDetail, getOverview, getTask, getUserDetail, getUserTasks } =
  await import('../../../../server/lib/queries')

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

describe('getOverview', () => {
  it('reports upstream invocation multiplier per requested image', async () => {
    const result = await getOverview('7d')
    const model = result.models.find((entry) => entry.model === 'normalized-multiplier')

    expect(model?.count).toBe(2)
    expect(model?.upstream_invocations).toBe(5)
    expect(model?.average_multiplier).toBe(1)
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

  it('失败任务的列表项带 upstream_status，供列表直接分辨 5xx / 4xx', async () => {
    const detail = await getDeviceDetail('dev-A-aaaa', '7d')
    const failed = detail.tasks.find((t) => t.id === 't3')
    expect(failed?.upstream_status).toBe(502)
    // 成功任务没有上游错误，保持 null
    expect(detail.tasks.find((t) => t.id === 't1')?.upstream_status).toBeNull()
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
    // prompt 与真实上游调用数正常预抽
    expect(detail.tasks[0]?.prompt).toBe('a big one')
    expect(detail.tasks[0]?.upstream_invocation_count).toBe(4)
  })
})

describe('getDeviceDetail 分页', () => {
  it('首页返回 PAGE_SIZE(100) 条 + nextCursor 非空 + 设备聚合 total=150', async () => {
    const p1 = await getDeviceDetail('dev-PAGE-xx', '30d')
    expect(p1.tasks).toHaveLength(100)
    expect(p1.nextCursor).not.toBeNull()
    expect(p1.tasks[0]?.id).toBe('pg-000')
    expect(p1.device!.total).toBe(150)
    // 列表展示 prompt 与真实上游调用数，不复用请求 n
    expect(p1.tasks[0]?.prompt).toBe('prompt-0')
    expect(p1.tasks[0]?.upstream_invocation_count).toBe(3)
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

describe('getUserDetail', () => {
  it('returns aggregates and the fixed 30-day trend, without a task page', async () => {
    const detail = await getUserDetail('user-page')
    expect(detail?.user?.username).toBe('page-user')
    expect(detail?.user?.task_count).toBe(151)
    expect(detail?.volume).toHaveLength(30)
    expect(detail?.volume_bucket).toBe('day')
    expect(detail?.volume_range).toBe('30d')
  })

  it('counts tasks older than any time range and keeps the trend at 30 days', async () => {
    const detail = await getUserDetail('user-history')
    expect(detail?.user?.task_count).toBe(1)
    // 趋势图固定 30 天：60 天前的任务不进任何桶，但仍计入历史任务数
    expect(detail?.volume?.reduce((sum, bucket) => sum + bucket.total, 0)).toBe(0)
  })

  it('returns null for an unknown user', async () => {
    expect(await getUserDetail('nobody')).toBeNull()
  })
})

describe('getUserTasks', () => {
  it('pages through the full history with a keyset cursor', async () => {
    const first = await getUserTasks('user-page', 'all')
    expect(first.tasks).toHaveLength(100)
    expect(first.nextCursor).not.toBeNull()
    expect(first.tasks.find((task) => task.id === 't3')?.upstream_status).toBe(502)

    const second = await getUserTasks('user-page', 'all', first.nextCursor!)
    expect(second.tasks).toHaveLength(51)
    expect(second.nextCursor).toBeNull()
    const firstIds = new Set(first.tasks.map((task) => task.id))
    expect(second.tasks.every((task) => !firstIds.has(task.id))).toBe(true)
  })

  it('lists tasks older than any time range', async () => {
    const page = await getUserTasks('user-history', 'all')
    expect(page.tasks.map((task) => task.id)).toEqual(['hist-60d'])
  })

  it('honours the status filter', async () => {
    expect((await getUserTasks('user-history', 'failed')).tasks).toEqual([])
  })
})

describe('getTask', () => {
  it('returns the detail whitelist with result_meta and without unrelated task columns', async () => {
    const task = await getTask('t1')
    expect(task).not.toBeNull()
    expect(task!.id).toBe('t1')
    expect((task as unknown as Record<string, unknown>).result_payload).toBeUndefined()
    expect(task!.result_meta).toBeDefined()
    expect(task!.upstream_invocation_count).toBe(2)
  })

  it('失败任务详情带上游 HTTP 状态与原始响应体', async () => {
    const task = await getTask('t3')
    expect(task).not.toBeNull()
    expect(task!.upstream_status).toBe(502)
    expect(task!.upstream_body).toBe(
      '{"error":{"message":"Upstream request failed","type":"upstream_error"}}',
    )
  })

  it('不存在的 task → null', async () => {
    const task = await getTask('nope')
    expect(task).toBeNull()
  })
})

afterAll(async () => {
  await writer.close()
})
