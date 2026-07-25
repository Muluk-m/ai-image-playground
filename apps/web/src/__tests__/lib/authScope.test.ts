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

  it('sanitizes ids before using them in a browser storage name', () => {
    setClientStorageScope('account/../../other')
    expect(scopedStorageName('db')).toBe('db:user-account_______other')
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
