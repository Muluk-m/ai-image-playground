import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb } from '@image-playground/db'
import { resetTestDatabase } from '@image-playground/db/testing'
import { QUEUE_TIMEOUTS } from '@image-playground/shared'
import type { OpsSnapshot } from '../../../../contracts'

const databaseUrl = await resetTestDatabase('admin_ops_route')
process.env.ADMIN_PASSWORD = 'test-pass-1234'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.DATABASE_URL = databaseUrl
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.PORT = '0'

// 部署记录来自宿主机上的部署日志；compose 把它只读挂进后台容器。
const deployDir = await mkdtemp(join(tmpdir(), 'admin-ops-deploys-'))
process.env.OPS_DEPLOYMENTS_LOG = join(deployDir, 'deployments.log')
process.env.OPS_DEPLOYMENT_NAME = 'paid'
await writeFile(
  process.env.OPS_DEPLOYMENTS_LOG,
  [
    '2026-09-18T00:04:32Z internal public=39d2cf1c private=e5ea2ae image=ai-image-playground:vps-main-39d2cf1c by=ubuntu@vps result=failed',
    'garbage that is not a deployment line',
    '2026-09-18T02:46:44Z paid public=58630254 private=79fc8056 image=ai-image-playground:paid-58630254-79fc8056 by=ubuntu@vps result=ok',
    '',
  ].join('\n'),
)

// 备份一栏经后端内部接口取：只有后端够得着对象存储。mock 要赶在 config 读 BFF_INTERNAL_URL 之前起。
const bffCalls: Array<{ path: string; authorization: string | null }> = []
const backupAt = Date.now() - 3 * 3600_000
const mockBff = Bun.serve({
  port: 0,
  fetch(request) {
    bffCalls.push({
      path: new URL(request.url).pathname,
      authorization: request.headers.get('authorization'),
    })
    return Response.json({
      latest: { key: 'pg/2026-09-17.dump', size_bytes: 42_000_000, modified_at: backupAt },
      previous: {
        key: 'pg/2026-09-16.dump',
        size_bytes: 41_000_000,
        modified_at: backupAt - 86_400_000,
      },
    })
  },
})
process.env.BFF_INTERNAL_URL = `http://127.0.0.1:${mockBff.port}`

const writer = createDb(databaseUrl)
const now = Date.now()
const minute = 60_000
const base = {
  provider: 'openai-compat',
  model: 'gpt-image-2',
  request_payload: { prompt: 'x', device_id: 'ops-device' },
} as const

await writer.db.insert(writer.schema.tasks).values([
  { ...base, id: 'ops-queued-old', status: 'queued', submitted_at: now - 12 * minute },
  { ...base, id: 'ops-queued-new', status: 'queued', submitted_at: now - 1 * minute },
  {
    ...base,
    id: 'ops-running',
    status: 'in_progress',
    submitted_at: now - 3 * minute,
    started_at: now - 2 * minute,
  },
  {
    ...base,
    id: 'ops-stuck',
    status: 'in_progress',
    submitted_at: now - 40 * minute,
    started_at: now - QUEUE_TIMEOUTS.STALE_IN_PROGRESS_MS - minute,
  },
  {
    ...base,
    id: 'ops-done',
    status: 'completed',
    submitted_at: now - 50 * minute,
    started_at: now - 50 * minute,
    completed_at: now - 49 * minute,
  },
  // 对话轮也是 tasks 里的一行，但不属于生成队列，看板的队列一栏不数它。
  { ...base, id: 'ops-chat-turn', kind: 'chat', status: 'queued', submitted_at: now - 30 * minute },
])

// 重新部署换了实例：每个服务只该报最新的那个实例。
await writer.db.insert(writer.schema.service_heartbeats).values([
  { service: 'bff', instance: 'bff-old', version: 'aaaaaaa', last_seen_at: now - 3 * 3600_000 },
  { service: 'bff', instance: 'bff-new', version: 'bbbbbbb', last_seen_at: now - 10_000 },
  {
    service: 'worker',
    instance: 'worker-new',
    version: 'bbbbbbb',
    last_seen_at: now - 20_000,
    detail: { last_successful_poll_at: now - 1_000 },
  },
])

// 宿主机采样：两天前磁盘还宽裕，现在快满了。看板要的是这条趋势，不只是最后一个数。
const GB = 1024 ** 3
// Anchor the old pair inside one half-hour bucket, even when CI starts at :29 or :59.
const oldHostBucket = Math.floor((now - 48 * 3600_000) / 1800_000) * 1800_000
const hostSample = (at: number, diskAvailable: number) => ({
  sampled_at: at,
  disk_total_bytes: 50 * GB,
  disk_available_bytes: diskAvailable,
  mem_total_bytes: 4 * GB,
  mem_available_bytes: 1 * GB,
})
await writer.db.insert(writer.schema.host_samples).values([
  hostSample(oldHostBucket + 60_000, 30 * GB),
  hostSample(oldHostBucket + 120_000, 30 * GB),
  hostSample(now - 3600_000, 10 * GB),
  {
    ...hostSample(now - 30_000, 5 * GB),
    cpu_count: 2,
    cpu_busy_ratio: 0.25,
    load_1: 0.5,
    load_5: 0.4,
    load_15: 0.3,
    swap_total_bytes: 2 * GB,
    swap_free_bytes: 2 * GB,
    booted_at: now - 2 * 3600_000,
  },
])

// 容器读数：两轮，数据库那个容器上一轮被 OOM 杀过一次进程。
const PG = 'a'.repeat(64)
const BFF = 'b'.repeat(64)
const containerSample = (
  at: number,
  id: string,
  mem: number,
  oom: number,
  name: string | null,
) => ({
  sampled_at: at,
  container_id: id,
  name,
  mem_bytes: mem,
  oom_kills: oom,
  cpu_cores: 0.1,
})
await writer.db
  .insert(writer.schema.container_samples)
  .values([
    containerSample(now - 3600_000, PG, 900 * 1024 ** 2, 0, 'image-playground-infra-postgres-1'),
    containerSample(now - 3600_000, BFF, 200 * 1024 ** 2, 0, 'image-playground-paid-bff-1'),
    containerSample(now - 30_000, PG, 400 * 1024 ** 2, 1, 'image-playground-infra-postgres-1'),
    containerSample(now - 30_000, BFF, 500 * 1024 ** 2, 0, null),
  ])

// 接口统计：最近一分钟有两个 5xx，两小时前那一分钟不算进「最近 15 分钟」。
const minuteStart = Math.floor(now / minute) * minute
await writer.db.insert(writer.schema.api_minutes).values([
  {
    minute: minuteStart - minute,
    instance: 'bff-new',
    requests: 40,
    client_errors: 3,
    server_errors: 2,
    p50_ms: 30,
    p95_ms: 400,
    max_ms: 900,
    server_error_routes: { 'POST /v1/queue/:provider/:model/submit': 2 },
  },
  {
    minute: minuteStart - 120 * minute,
    instance: 'bff-new',
    requests: 10,
    client_errors: 0,
    server_errors: 0,
    p50_ms: 20,
    p95_ms: 50,
    max_ms: 60,
    server_error_routes: null,
  },
])

const { app } = await import('../../../../server/app')

afterAll(async () => {
  mockBff.stop()
  await writer.close()
  await rm(deployDir, { recursive: true, force: true })
})

async function login(): Promise<string> {
  const response = await app.handle(
    new Request('http://localhost/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.176' },
      body: JSON.stringify({ password: 'test-pass-1234' }),
    }),
  )
  return response.headers.get('set-cookie')!.split(';')[0]!
}

describe('GET /api/ops', () => {
  it('requires the admin session', async () => {
    const response = await app.handle(new Request('http://localhost/api/ops'))
    expect(response.status).toBe(401)
  })

  it('reports the queue as the worker sees it: counts, the oldest wait, and what is stuck', async () => {
    const cookie = await login()
    const response = await app.handle(
      new Request('http://localhost/api/ops', { headers: { cookie } }),
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as OpsSnapshot

    if (!body.queue.ok) throw new Error(body.queue.error)
    const queue = body.queue.data
    expect(queue.queued).toBe(2)
    expect(queue.in_progress).toBe(2)
    expect(queue.oldest_queued_wait_ms).toBeGreaterThanOrEqual(12 * minute)
    expect(queue.oldest_queued_wait_ms).toBeLessThan(13 * minute)
    // 「卡住」与 worker 回收无主任务用的是同一个阈值，不另立标准。
    expect(queue.stale_after_ms).toBe(QUEUE_TIMEOUTS.STALE_IN_PROGRESS_MS)
    expect(queue.stuck.map((task) => task.id)).toEqual(['ops-stuck'])
  })

  it('reports how big the database is and which tables hold the most', async () => {
    const cookie = await login()
    const response = await app.handle(
      new Request('http://localhost/api/ops', { headers: { cookie } }),
    )
    const body = (await response.json()) as OpsSnapshot

    if (!body.database.ok) throw new Error(body.database.error)
    expect(body.database.data.size_bytes).toBeGreaterThan(0)
    expect(body.database.data.tables.length).toBeGreaterThan(0)
    expect(body.database.data.tables.map((table) => table.name)).toContain('tasks')
    const sizes = body.database.data.tables.map((table) => table.bytes)
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a))
  })

  it('reads the newest backup through the BFF, with the service credential', async () => {
    const cookie = await login()
    const response = await app.handle(
      new Request('http://localhost/api/ops', { headers: { cookie } }),
    )
    const body = (await response.json()) as OpsSnapshot

    if (!body.backup.ok) throw new Error(body.backup.error)
    expect(body.backup.data.latest).toEqual({
      key: 'pg/2026-09-17.dump',
      size_bytes: 42_000_000,
      modified_at: backupAt,
    })
    expect(body.backup.data.previous?.size_bytes).toBe(41_000_000)
    expect(bffCalls.at(-1)).toEqual({
      path: '/internal/admin/ops/backups',
      authorization: 'Bearer fixture-service-credential-alpha',
    })
  })

  it('reports the current instance of each service with the version it runs', async () => {
    const cookie = await login()
    const response = await app.handle(
      new Request('http://localhost/api/ops', { headers: { cookie } }),
    )
    const body = (await response.json()) as OpsSnapshot

    if (!body.services.ok) throw new Error(body.services.error)
    expect(body.services.data.services).toEqual([
      {
        service: 'bff',
        instance: 'bff-new',
        version: 'bbbbbbb',
        last_seen_at: now - 10_000,
        last_successful_poll_at: null,
      },
      {
        service: 'worker',
        instance: 'worker-new',
        version: 'bbbbbbb',
        last_seen_at: now - 20_000,
        last_successful_poll_at: now - 1_000,
      },
    ])
  })

  it('reports the latest host reading and a downsampled week, oldest first', async () => {
    const cookie = await login()
    const response = await app.handle(
      new Request('http://localhost/api/ops', { headers: { cookie } }),
    )
    const body = (await response.json()) as OpsSnapshot

    if (!body.host.ok) throw new Error(body.host.error)
    const { latest, series } = body.host.data
    expect(latest).toEqual({
      ...hostSample(now - 30_000, 5 * GB),
      cpu_count: 2,
      cpu_busy_ratio: 0.25,
      load_1: 0.5,
      load_5: 0.4,
      load_15: 0.3,
      swap_total_bytes: 2 * GB,
      swap_free_bytes: 2 * GB,
      booted_at: now - 2 * 3600_000,
    })
    // 同一个半小时桶里的两条读数并成一个点。
    expect(series.length).toBe(3)
    expect(series.map((point) => point.at)).toEqual(
      [...series.map((point) => point.at)].sort((a, b) => a - b),
    )
    expect(series[0]?.disk_used_ratio).toBeCloseTo(0.4, 5)
    expect(series.at(-1)?.disk_used_ratio).toBeGreaterThan(0.8)
    expect(series[0]?.mem_available_ratio).toBeCloseTo(0.25, 5)
  })

  it('lists every container of the newest reading with its week peak and fresh OOM kills', async () => {
    const cookie = await login()
    const body = (await (
      await app.handle(new Request('http://localhost/api/ops', { headers: { cookie } }))
    ).json()) as OpsSnapshot

    if (!body.containers.ok) throw new Error(body.containers.error)
    const { sampled_at, containers } = body.containers.data
    expect(sampled_at).toBe(now - 30_000)
    // 按当前内存从大到小；对照表里没有的容器名为 null。
    expect(containers.map((one) => [one.name, one.mem_bytes])).toEqual([
      [null, 500 * 1024 ** 2],
      ['image-playground-infra-postgres-1', 400 * 1024 ** 2],
    ])
    expect(containers[1]).toMatchObject({ peak_mem_bytes: 900 * 1024 ** 2, recent_oom_kills: 1 })
  })

  it('sums the last 15 minutes of API traffic and names the routes that returned 5xx', async () => {
    const cookie = await login()
    const body = (await (
      await app.handle(new Request('http://localhost/api/ops', { headers: { cookie } }))
    ).json()) as OpsSnapshot

    if (!body.api.ok) throw new Error(body.api.error)
    expect(body.api.data.recent).toEqual({
      requests: 40,
      client_errors: 3,
      server_errors: 2,
      p95_ms: 400,
    })
    expect(body.api.data.series.length).toBe(2)
    expect(body.api.data.error_routes).toEqual([
      { route: 'POST /v1/queue/:provider/:model/submit', count: 2 },
    ])
  })

  it('reads recent deployments from the deploy log, newest first, skipping lines it cannot read', async () => {
    const cookie = await login()
    const body = (await (
      await app.handle(new Request('http://localhost/api/ops', { headers: { cookie } }))
    ).json()) as OpsSnapshot

    if (!body.deployments.ok) throw new Error(body.deployments.error)
    expect(body.deployments.data.own).toBe('paid')
    expect(body.deployments.data.available).toBe(true)
    expect(body.deployments.data.entries).toEqual([
      {
        at: Date.parse('2026-09-18T02:46:44Z'),
        target: 'paid',
        public_sha: '58630254',
        private_sha: '79fc8056',
        image: 'ai-image-playground:paid-58630254-79fc8056',
        by: 'ubuntu@vps',
        ok: true,
      },
      expect.objectContaining({ target: 'internal', private_sha: 'e5ea2ae', ok: false }),
    ])
  })
})
