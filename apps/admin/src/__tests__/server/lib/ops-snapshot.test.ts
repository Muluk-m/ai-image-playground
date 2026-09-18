import { describe, expect, it } from 'bun:test'

// 这组用例只测拼装，不碰数据库；env 只是为了让 server/config 能被加载。
process.env.ADMIN_PASSWORD = 'test-pass-1234'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.DATABASE_URL = 'postgres://unused@127.0.0.1:1/unused'
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'

const { buildOpsSnapshot, OpsReadError } = await import('../../../../server/lib/ops')

/**
 * 看板的每一块独立取、独立失败。对象存储抖一下、某条查询超时，只该让那一块显示取不到，
 * 不该让整页空白——出事的时候恰恰是最需要看其余几块的时候。
 */
const healthy = {
  queue: async () => ({
    queued: 0,
    in_progress: 0,
    oldest_queued_wait_ms: null,
    stale_after_ms: 1,
    stuck: [],
  }),
  database: async () => ({ size_bytes: 42, tables: [] }),
  backup: async () => ({ latest: null, previous: null }),
  services: async () => ({ services: [] }),
  host: async () => ({ latest: null, series: [] }),
  containers: async () => ({ sampled_at: null, containers: [] }),
  api: async () => ({
    recent: { requests: 0, client_errors: 0, server_errors: 0, p95_ms: null },
    window_ms: 1,
    series: [],
    error_routes: [],
  }),
  deployments: async () => ({ own: null, available: false, entries: [] }),
}

describe('buildOpsSnapshot', () => {
  it('keeps the healthy blocks when one source throws', async () => {
    const snapshot = await buildOpsSnapshot({
      ...healthy,
      queue: async () => {
        throw new Error('connection to server at "10.0.0.7", port 5432 failed')
      },
    })

    expect(snapshot.queue.ok).toBe(false)
    expect(snapshot.database).toEqual({ ok: true, data: { size_bytes: 42, tables: [] } })
    expect(snapshot.generated_at).toBeGreaterThan(0)
  })

  it('never shows a driver error to the browser', async () => {
    const snapshot = await buildOpsSnapshot({
      ...healthy,
      database: async () => {
        throw new Error('connection to server at "10.0.0.7", port 5432 failed for role admin_user')
      },
    })

    expect(JSON.stringify(snapshot)).not.toContain('10.0.0.7')
    expect(JSON.stringify(snapshot)).not.toContain('admin_user')
  })

  it('shows the reasons the board wrote itself', async () => {
    const snapshot = await buildOpsSnapshot({
      ...healthy,
      backup: async () => {
        throw new OpsReadError('后端返回 502')
      },
    })

    expect(snapshot.backup).toEqual({ ok: false, error: '后端返回 502' })
  })

  it('starts every block before the slow one finishes', async () => {
    let releaseQueue = () => {}
    const queueGate = new Promise<void>((resolve) => {
      releaseQueue = resolve
    })
    const startedBeforeQueueFinished: string[] = []
    const track =
      <T>(name: string, value: T) =>
      async () => {
        startedBeforeQueueFinished.push(name)
        // 最后一块也起跑了才放行最慢的那块：串行实现会永远卡在 queue 上，用例超时失败。
        if (name === 'deployments') releaseQueue()
        return value
      }

    const snapshot = await buildOpsSnapshot({
      queue: async () => {
        await queueGate
        return healthy.queue()
      },
      database: track('database', { size_bytes: 1, tables: [] }),
      backup: track('backup', { latest: null, previous: null }),
      services: track('services', { services: [] }),
      host: track('host', { latest: null, series: [] }),
      containers: track('containers', { sampled_at: null, containers: [] }),
      api: track('api', await healthy.api()),
      deployments: track('deployments', { own: null, available: false, entries: [] }),
    })

    expect(snapshot.queue.ok).toBe(true)
    expect(startedBeforeQueueFinished).toEqual([
      'database',
      'backup',
      'services',
      'host',
      'containers',
      'api',
      'deployments',
    ])
  })

  it('gives up on a block that hangs and still answers with the rest', async () => {
    const snapshot = await buildOpsSnapshot(
      { ...healthy, database: () => new Promise<never>(() => {}) },
      30,
    )

    expect(snapshot.database.ok).toBe(false)
    expect(snapshot.queue.ok).toBe(true)
    expect(snapshot.backup.ok).toBe(true)
  })
})
