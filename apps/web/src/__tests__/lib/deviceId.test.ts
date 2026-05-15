import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const STORAGE_KEY = 'image-playground.device_id'

/**
 * Vitest 默认跑在 node env，无 DOM。手动塞个最小 localStorage shim，
 * 行为对齐 Web Storage（同步、错误时抛）。
 */
function makeLocalStorageShim(): {
  storage: Storage
  setThrowMode: (mode: 'none' | 'get' | 'set' | 'both') => void
} {
  const store = new Map<string, string>()
  let throwMode: 'none' | 'get' | 'set' | 'both' = 'none'
  const shim: Storage = {
    get length() {
      return store.size
    },
    clear() {
      store.clear()
    },
    getItem(key: string) {
      if (throwMode === 'get' || throwMode === 'both') {
        throw new Error('SecurityError')
      }
      return store.has(key) ? (store.get(key) ?? null) : null
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null
    },
    removeItem(key: string) {
      store.delete(key)
    },
    setItem(key: string, value: string) {
      if (throwMode === 'set' || throwMode === 'both') {
        throw new Error('QuotaExceededError')
      }
      store.set(key, value)
    },
  }
  return {
    storage: shim,
    setThrowMode: (mode) => {
      throwMode = mode
    },
  }
}

let shim: ReturnType<typeof makeLocalStorageShim>

describe('getDeviceId', () => {
  beforeEach(() => {
    shim = makeLocalStorageShim()
    vi.stubGlobal('localStorage', shim.storage)
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('首次调用：生成 UUID 写入 localStorage', async () => {
    const { getDeviceId } = await import('../../lib/deviceId')
    const id = getDeviceId()
    expect(id).toMatch(/^[0-9a-f-]{36}$/i)
    expect(localStorage.getItem(STORAGE_KEY)).toBe(id)
  })

  it('第二次调用：返回缓存的同一 ID', async () => {
    const { getDeviceId } = await import('../../lib/deviceId')
    const id1 = getDeviceId()
    const id2 = getDeviceId()
    expect(id2).toBe(id1)
  })

  it('已有 localStorage 值：直接复用', async () => {
    localStorage.setItem(STORAGE_KEY, 'existing-uuid-abcd-efgh')
    const { getDeviceId } = await import('../../lib/deviceId')
    expect(getDeviceId()).toBe('existing-uuid-abcd-efgh')
  })

  it('localStorage 中值过短：当作不存在，重新生成', async () => {
    localStorage.setItem(STORAGE_KEY, 'short')
    const { getDeviceId } = await import('../../lib/deviceId')
    const id = getDeviceId()
    expect(id).not.toBe('short')
    expect(id).toMatch(/^[0-9a-f-]{36}$/i)
    expect(localStorage.getItem(STORAGE_KEY)).toBe(id)
  })

  it('localStorage 抛错（隐私模式 / SSR）：fallback in-memory ID', async () => {
    shim.setThrowMode('both')
    const { getDeviceId } = await import('../../lib/deviceId')
    const id = getDeviceId()
    expect(id).toMatch(/^[0-9a-f-]{36}$/i)
    // 同 session 内再调用应返同 ID
    expect(getDeviceId()).toBe(id)
  })
})
