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
  resultPayload?: unknown
  errorMessage?: string
  upstreamStatus?: number
  upstreamBody?: string
}) {
  writer.db
    .insert(writer.schema.tasks)
    .values({
      id: args.id,
      provider: args.provider,
      model: args.model,
      status: args.status,
      request_payload: { prompt: 'p', device_id: args.device } as never,
      result_payload: args.resultPayload as never,
      error_message: args.errorMessage ?? null,
      upstream_status: args.upstreamStatus ?? null,
      upstream_body: args.upstreamBody ?? null,
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
  resultPayload: {
    data: [{}],
    _image_meta: [{ index: 0, mime: 'image/webp' }],
  },
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
  errorMessage: 'Upstream request failed',
  upstreamStatus: 502,
  upstreamBody: '{"error":{"message":"Upstream request failed","type":"upstream_error"}}',
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

// dev-PAGE：150 个 task，验证 cursor 分页（PAGE_SIZE=100）。
// submitted_at 逐条递减（pg-000 最新），排序 (submitted_at DESC, id DESC) 下 pg-000 在首。
for (let i = 0; i < 150; i++) {
  writer.db
    .insert(writer.schema.tasks)
    .values({
      id: `pg-${String(i).padStart(3, '0')}`,
      provider: 'openai-compat',
      model: 'gpt-image-2',
      status: 'completed',
      request_payload: { prompt: `prompt-${i}`, n: 2, device_id: 'dev-PAGE-xx' } as never,
      submitted_at: now - i * 1000,
      completed_at: now - i * 1000 + 500,
    })
    .run()
}

// dev-BIG：一条带 ~120KB input_images base64 的 task，验证列表响应把它剔除（瘦身命门）。
writer.db
  .insert(writer.schema.tasks)
  .values({
    id: 'big-1',
    provider: 'openai-compat',
    model: 'gpt-image-2',
    status: 'completed',
    request_payload: {
      prompt: 'a big one',
      n: 1,
      device_id: 'dev-BIG-xx',
      input_images: [`data:image/png;base64,${'BIGIMAGEDATA'.repeat(10_000)}`],
    } as never,
    submitted_at: now,
    completed_at: now + 1000,
  })
  .run()

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
  it('returns the detail whitelist with result_meta and without unrelated task columns', async () => {
    const task = await getTask('t1')
    expect(task).not.toBeNull()
    expect(task!.id).toBe('t1')
    const response = task as unknown as Record<string, unknown>
    expect(response.result_payload).toBeUndefined()
    expect(response.client_request_id).toBeUndefined()
    expect(task!.request_payload).toEqual({ prompt: 'p', device_id: 'dev-A-aaaa' })
    expect(task!.result_meta).toEqual({ images: [{ index: 0, mime: 'image/webp' }] })
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

afterAll(() => writer.sqlite.close())
