// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BUILD_META_NAME,
  PRELOAD_RELOAD_STORAGE_KEY,
  RELOAD_QUERY_PARAM,
} from '../../boot/constants'
import {
  CHUNK_IMPORT_ATTEMPTS,
  CHUNK_IMPORT_BACKOFF_MS,
  hardReload,
  importWithRetry,
  isChunkLoadError,
  isDynamicImportFailure,
  lazyWithRetry,
  reloadOnceForChunkFailure,
} from '../../lib/chunkLoad'

afterEach(() => {
  sessionStorage.clear()
  document.head.innerHTML = ''
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('isChunkLoadError', () => {
  it('recognizes dynamic import failures and ignores ordinary errors', () => {
    expect(
      isDynamicImportFailure(
        new TypeError(
          'Failed to fetch dynamically imported module: https://muvloom.online/assets/AuthGate-C6rHP2S1.js',
        ),
      ),
    ).toBe(true)
    expect(isChunkLoadError(Object.assign(new Error('nope'), { name: 'ChunkLoadError' }))).toBe(
      true,
    )
    expect(isChunkLoadError(new Error('Load failed'))).toBe(true)
    expect(isDynamicImportFailure(new TypeError('Failed to fetch'))).toBe(false)
    expect(isChunkLoadError(new Error('canvas render failed'))).toBe(false)
  })
})

describe('importWithRetry', () => {
  it('returns the module when the second attempt succeeds and does not reload', async () => {
    vi.useFakeTimers()
    const reload = vi.fn(() => true)
    const load = vi
      .fn<() => Promise<{ default: string }>>()
      .mockRejectedValueOnce(
        new TypeError('Failed to fetch dynamically imported module: /assets/AuthGate-C6rHP2S1.js'),
      )
      .mockResolvedValueOnce({ default: 'app' })
    const pending = importWithRetry(load, {
      reload,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    })
    await vi.advanceTimersByTimeAsync(CHUNK_IMPORT_BACKOFF_MS)
    await expect(pending).resolves.toEqual({ default: 'app' })
    expect(load).toHaveBeenCalledTimes(CHUNK_IMPORT_ATTEMPTS)
    expect(reload).not.toHaveBeenCalled()
  })

  it('does not retry a module that evaluated and threw', async () => {
    const load = vi.fn().mockRejectedValue(new Error('canvas render failed'))
    const reload = vi.fn(() => true)
    await expect(importWithRetry(load, { reload })).rejects.toThrow('canvas render failed')
    expect(load).toHaveBeenCalledOnce()
    expect(reload).not.toHaveBeenCalled()
  })

  it('reloads once after the retries are exhausted, and does not resolve into the boundary', async () => {
    vi.useFakeTimers()
    const reload = vi.fn(() => true)
    const load = vi.fn().mockRejectedValue(new TypeError('Importing a module script failed.'))
    let settled = false
    const pending = importWithRetry(load, {
      reload,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    }).then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(CHUNK_IMPORT_BACKOFF_MS)
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(CHUNK_IMPORT_ATTEMPTS)
    expect(reload).toHaveBeenCalledOnce()
    expect(settled).toBe(false)
    pending.catch(() => {})
  })

  it('uses one reload when several chunks fail together', async () => {
    const reload = vi.fn(() => true)
    const fail = () =>
      Promise.reject(new TypeError('Failed to fetch dynamically imported module: /assets/A.js'))
    const first = importWithRetry(fail, { attempts: 1, reload })
    const second = importWithRetry(fail, { attempts: 1, reload })
    const outcome = await Promise.race([
      Promise.all([first, second]).then(
        () => 'resolved',
        () => 'rejected',
      ),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 30)),
    ])
    expect(outcome).toBe('pending')
    expect(reload).toHaveBeenCalledOnce()
  })

  it('throws when the one-shot reload is already spent', async () => {
    const reload = vi.fn(() => false)
    const load = vi.fn().mockRejectedValue(new TypeError('Loading chunk 8 failed.'))
    await expect(importWithRetry(load, { attempts: 2, backoffMs: 0, reload })).rejects.toThrow(
      'Loading chunk 8 failed.',
    )
    expect(reload).toHaveBeenCalledOnce()
  })

  it('wraps React.lazy with the same retry', async () => {
    const Lazy = lazyWithRetry(() => Promise.resolve({ default: () => null }))
    expect(typeof Lazy).toBe('object')
    const loaded = await importWithRetry(() => Promise.resolve({ default: Lazy }), {
      reload: false,
    })
    expect(loaded.default).toBe(Lazy)
  })
})

describe('reload budget', () => {
  function stubLocation(href: string) {
    const replace = vi.fn()
    vi.stubGlobal('location', { href, replace })
    return replace
  }

  it('hard reload keeps the path, query, and hash and clears the automatic budget', () => {
    sessionStorage.setItem(PRELOAD_RELOAD_STORAGE_KEY, 'spent|build')
    const replace = stubLocation('https://muvloom.online/p/project?mode=canvas#selection')
    hardReload()
    expect(sessionStorage.getItem(PRELOAD_RELOAD_STORAGE_KEY)).toBeNull()
    const next = new URL(replace.mock.calls[0]![0])
    expect(next.pathname).toBe('/p/project')
    expect(next.searchParams.get('mode')).toBe('canvas')
    expect(next.hash).toBe('#selection')
    expect(next.searchParams.has(RELOAD_QUERY_PARAM)).toBe(true)
  })

  it('auto-reloads once per HTML build and then refuses', () => {
    const meta = document.createElement('meta')
    meta.name = BUILD_META_NAME
    meta.content = 'release-b'
    document.head.append(meta)
    const replace = stubLocation('https://muvloom.online/image')
    expect(reloadOnceForChunkFailure()).toBe(true)
    expect(replace).toHaveBeenCalledTimes(1)
    expect(reloadOnceForChunkFailure()).toBe(false)
    expect(replace).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem(PRELOAD_RELOAD_STORAGE_KEY)).toMatch(/\|release-b$/)
  })

  it('does not auto-reload while offline', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const replace = stubLocation('https://muvloom.online/image')
    expect(reloadOnceForChunkFailure()).toBe(false)
    expect(replace).not.toHaveBeenCalled()
  })
})
