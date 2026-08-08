import { afterEach, describe, expect, it } from 'vitest'
import { scopedLocalStorage, scopedStorageName, setClientStorageScope } from '../../lib/authScope'

describe('auth-scoped browser storage', () => {
  afterEach(() => {
    setClientStorageScope(null)
  })

  it('keeps legacy storage names for the anonymous deployment', () => {
    setClientStorageScope(null)
    expect(scopedStorageName('image-playground')).toBe('image-playground')
    expect(scopedStorageName('image-playground-v3')).toBe('image-playground-v3')
  })

  it('uses separate storage names for each authenticated user', () => {
    setClientStorageScope('user-a')
    expect(scopedStorageName('image-playground')).toBe('image-playground:user-user-a')

    setClientStorageScope('user-b')
    expect(scopedStorageName('image-playground')).toBe('image-playground:user-user-b')
  })

  it('escapes ids before using them in a browser storage name', () => {
    setClientStorageScope('account/../../other')
    expect(scopedStorageName('db')).toBe('db:user-account%2F..%2F..%2Fother')
  })

  it('never maps two different ids onto the same namespace', () => {
    // 编码必须是单射的：有损替换会让 `a/b` 和 `a_b` 落进同一个命名空间，
    // 两个账号就会共用 localStorage 设置、IndexedDB 图片与 BYOK 配置。
    setClientStorageScope('a/b')
    const slashed = scopedStorageName('db')
    setClientStorageScope('a_b')
    const underscored = scopedStorageName('db')
    expect(slashed).not.toBe(underscored)
  })

  it('reads and writes only the active user namespace', () => {
    const values = new Map<string, string>()
    const previous = globalThis.localStorage
    globalThis.localStorage = {
      get length() {
        return values.size
      },
      clear: () => values.clear(),
      getItem: (key) => values.get(key) ?? null,
      key: (index) => Array.from(values.keys())[index] ?? null,
      removeItem: (key) => {
        values.delete(key)
      },
      setItem: (key, value) => {
        values.set(key, value)
      },
    }

    try {
      setClientStorageScope('alice')
      scopedLocalStorage.setItem('settings', 'alice-value')
      setClientStorageScope('bob')
      scopedLocalStorage.setItem('settings', 'bob-value')

      expect(scopedLocalStorage.getItem('settings')).toBe('bob-value')
      setClientStorageScope('alice')
      expect(scopedLocalStorage.getItem('settings')).toBe('alice-value')
    } finally {
      globalThis.localStorage = previous
    }
  })
})
