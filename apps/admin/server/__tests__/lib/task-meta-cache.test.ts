import { describe, expect, it } from 'bun:test'

process.env.ADMIN_PASSWORD = 'test-pass-1234'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.DATABASE_URL = './artifacts/test-admin-cache.sqlite'
process.env.PORT = '0'

const { createTaskMetaCache } = await import('../../lib/task-meta-cache')

describe('createTaskMetaCache', () => {
  it('miss 时调 loader；命中后再调不触发 loader', async () => {
    let loaderCalls = 0
    const cache = createTaskMetaCache({
      maxEntries: 10,
      ttlMs: 30_000,
      load: async (taskId) => {
        loaderCalls++
        return { provider: 'openai-compat', model: 'm1', taskId }
      },
    })
    const r1 = await cache.get('t1')
    const r2 = await cache.get('t1')
    expect(loaderCalls).toBe(1)
    expect(r1?.provider).toBe('openai-compat')
    expect(r2).toBe(r1)
  })

  it('TTL 过后 miss 重新 load', async () => {
    let loaderCalls = 0
    const cache = createTaskMetaCache({
      maxEntries: 10,
      ttlMs: 5, // 5ms
      load: async (taskId) => {
        loaderCalls++
        return { provider: 'gemini', model: 'm2', taskId }
      },
    })
    await cache.get('t-ttl')
    await new Promise((r) => setTimeout(r, 20))
    await cache.get('t-ttl')
    expect(loaderCalls).toBe(2)
  })

  it('loader 返 null：缓存 null（避免反复 SQL）', async () => {
    let loaderCalls = 0
    const cache = createTaskMetaCache({
      maxEntries: 10,
      ttlMs: 30_000,
      load: async () => {
        loaderCalls++
        return null
      },
    })
    expect(await cache.get('missing')).toBeNull()
    expect(await cache.get('missing')).toBeNull()
    expect(loaderCalls).toBe(1)
  })

  it('maxEntries 满后淘汰最老', async () => {
    let aLoadCount = 0
    const cache = createTaskMetaCache<{ taskId: string }>({
      maxEntries: 2,
      ttlMs: 30_000,
      load: async (taskId) => {
        if (taskId === 'a') aLoadCount++
        return { taskId }
      },
    })
    await cache.get('a') // a load #1, entries = {a}
    await cache.get('b') // entries = {a, b}
    await cache.get('c') // 容量满 → 淘汰 a；entries = {b, c}
    await cache.get('a') // a 已淘汰，重 load → load #2; entries = {c, a}
    expect(aLoadCount).toBe(2)
  })
})
