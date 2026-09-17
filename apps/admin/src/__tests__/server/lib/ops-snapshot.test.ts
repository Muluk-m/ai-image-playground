import { describe, expect, it } from 'bun:test'

// 这组用例只测拼装，不碰数据库；env 只是为了让 server/config 能被加载。
process.env.ADMIN_PASSWORD = 'test-pass-1234'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.DATABASE_URL = 'postgres://unused@127.0.0.1:1/unused'
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'

const { buildOpsSnapshot } = await import('../../../../server/lib/ops')

/**
 * 看板的每一块独立取、独立失败。对象存储抖一下、某条查询超时，只该让那一块显示取不到，
 * 不该让整页空白——出事的时候恰恰是最需要看其余几块的时候。
 */
describe('buildOpsSnapshot', () => {
  it('keeps the healthy blocks when one source throws', async () => {
    const snapshot = await buildOpsSnapshot({
      queue: async () => {
        throw new Error('connection reset')
      },
      database: async () => ({ size_bytes: 42, tables: [] }),
      backup: async () => ({ latest: null, previous: null }),
      services: async () => ({ services: [] }),
      host: async () => ({ latest: null, series: [] }),
    })

    expect(snapshot.queue).toEqual({ ok: false, error: 'connection reset' })
    expect(snapshot.database).toEqual({ ok: true, data: { size_bytes: 42, tables: [] } })
    expect(snapshot.generated_at).toBeGreaterThan(0)
  })

  it('does not wait for a slow block before starting the others', async () => {
    const started: string[] = []
    await buildOpsSnapshot({
      queue: async () => {
        started.push('queue')
        await new Promise((resolve) => setTimeout(resolve, 20))
        return {
          queued: 0,
          in_progress: 0,
          oldest_queued_wait_ms: null,
          stale_after_ms: 1,
          stuck: [],
        }
      },
      database: async () => {
        started.push('database')
        return { size_bytes: 1, tables: [] }
      },
      backup: async () => {
        started.push('backup')
        return { latest: null, previous: null }
      },
      services: async () => {
        started.push('services')
        return { services: [] }
      },
      host: async () => {
        started.push('host')
        return { latest: null, series: [] }
      },
    })
    expect(started).toEqual(['queue', 'database', 'backup', 'services', 'host'])
  })
})
