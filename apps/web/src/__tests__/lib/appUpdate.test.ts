import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetBootVersionForTesting,
  checkForUpdate,
  parseVersionManifest,
  readSkippedVersion,
  writeSkippedVersion,
} from '../../lib/appUpdate'

function localStorageShim() {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  }
}

/** 依次返回给定的响应；用完后一直返回最后一个。 */
function fetcherOf(...responses: Array<{ status?: number; body?: unknown; throws?: boolean }>) {
  let index = 0
  return vi.fn(async () => {
    const step = responses[Math.min(index, responses.length - 1)]!
    index += 1
    if (step.throws) throw new Error('network down')
    return new Response(JSON.stringify(step.body), {
      status: step.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  })
}

beforeEach(() => {
  _resetBootVersionForTesting()
  vi.stubGlobal('localStorage', localStorageShim())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parseVersionManifest', () => {
  it('accepts a well-formed manifest', () => {
    expect(parseVersionManifest({ version: 'abc-1', notify: true })).toEqual({
      version: 'abc-1',
      notify: true,
    })
  })

  it('defaults notify to false when it is missing or not a boolean true', () => {
    expect(parseVersionManifest({ version: 'abc-1' })?.notify).toBe(false)
    expect(parseVersionManifest({ version: 'abc-1', notify: 'true' })?.notify).toBe(false)
  })

  it('rejects anything without a non-empty version string', () => {
    expect(parseVersionManifest(null)).toBeNull()
    expect(parseVersionManifest('<!doctype html>')).toBeNull()
    expect(parseVersionManifest({ notify: true })).toBeNull()
    expect(parseVersionManifest({ version: '', notify: true })).toBeNull()
  })
})

describe('checkForUpdate', () => {
  it('anchors on the first fetch, then prompts once the published version differs', async () => {
    const fetcher = fetcherOf(
      { body: { version: 'abc-1', notify: true } },
      { body: { version: 'abc-1', notify: true } },
      { body: { version: 'abc-2', notify: true } },
    )
    expect(await checkForUpdate(fetcher)).toBeNull()
    expect(await checkForUpdate(fetcher)).toBeNull()
    expect(await checkForUpdate(fetcher)).toBe('abc-2')
  })

  it('stays silent for a new version published without notify', async () => {
    const fetcher = fetcherOf(
      { body: { version: 'abc-1', notify: false } },
      { body: { version: 'abc-2', notify: false } },
    )
    expect(await checkForUpdate(fetcher)).toBeNull()
    expect(await checkForUpdate(fetcher)).toBeNull()
  })

  it('stays silent for a skipped version but prompts for the next one', async () => {
    const fetcher = fetcherOf(
      { body: { version: 'abc-1', notify: true } },
      { body: { version: 'abc-2', notify: true } },
      { body: { version: 'abc-3', notify: true } },
    )
    expect(await checkForUpdate(fetcher)).toBeNull()

    writeSkippedVersion('abc-2')
    expect(await checkForUpdate(fetcher)).toBeNull()
    expect(await checkForUpdate(fetcher)).toBe('abc-3')
  })

  it('anchors on the first success, not on a failed attempt', async () => {
    const fetcher = fetcherOf(
      { throws: true },
      { body: { version: 'abc-1', notify: true } },
      { body: { version: 'abc-2', notify: true } },
    )
    expect(await checkForUpdate(fetcher)).toBeNull()
    expect(await checkForUpdate(fetcher)).toBeNull()
    expect(await checkForUpdate(fetcher)).toBe('abc-2')
  })

  it('swallows network errors, non-2xx responses and unparsable bodies', async () => {
    const seeded = { body: { version: 'abc-1', notify: true } }
    for (const failure of [
      { throws: true },
      { status: 404, body: {} },
      { body: '<!doctype html>' },
    ]) {
      _resetBootVersionForTesting()
      const fetcher = fetcherOf(seeded, failure)
      expect(await checkForUpdate(fetcher)).toBeNull()
      expect(await checkForUpdate(fetcher)).toBeNull()
    }
  })

  it('keeps the skipped version out of reach when localStorage throws', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    })
    const fetcher = fetcherOf(
      { body: { version: 'abc-1', notify: true } },
      { body: { version: 'abc-2', notify: true } },
    )
    expect(await checkForUpdate(fetcher)).toBeNull()

    expect(() => writeSkippedVersion('abc-2')).not.toThrow()
    expect(readSkippedVersion()).toBeNull()
    expect(await checkForUpdate(fetcher)).toBe('abc-2')
  })
})
