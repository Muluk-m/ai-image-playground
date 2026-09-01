import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createUpdateChecker,
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
  const fetcher = vi.fn(async () => {
    const step = responses[Math.min(index, responses.length - 1)]!
    index += 1
    if (step.throws) throw new Error('network down')
    return new Response(JSON.stringify(step.body), {
      status: step.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  return fetcher
}

beforeEach(() => {
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

describe('skipped version storage', () => {
  it('round-trips through localStorage', () => {
    expect(readSkippedVersion()).toBeNull()
    writeSkippedVersion('abc-2')
    expect(readSkippedVersion()).toBe('abc-2')
  })

  it('stays quiet when localStorage throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    })
    expect(() => writeSkippedVersion('abc-2')).not.toThrow()
    expect(readSkippedVersion()).toBeNull()
  })
})

describe('createUpdateChecker', () => {
  it('takes the first successful fetch as its own version and does not prompt', async () => {
    const check = createUpdateChecker(fetcherOf({ body: { version: 'abc-1', notify: true } }))
    expect(await check()).toBeNull()
  })

  it('prompts once the published version differs and notify is set', async () => {
    const check = createUpdateChecker(
      fetcherOf(
        { body: { version: 'abc-1', notify: true } },
        { body: { version: 'abc-2', notify: true } },
      ),
    )
    expect(await check()).toBeNull()
    expect(await check()).toBe('abc-2')
  })

  it('stays silent for an unchanged version', async () => {
    const check = createUpdateChecker(fetcherOf({ body: { version: 'abc-1', notify: true } }))
    expect(await check()).toBeNull()
    expect(await check()).toBeNull()
  })

  it('stays silent for a new version published without notify', async () => {
    const check = createUpdateChecker(
      fetcherOf(
        { body: { version: 'abc-1', notify: false } },
        { body: { version: 'abc-2', notify: false } },
      ),
    )
    expect(await check()).toBeNull()
    expect(await check()).toBeNull()
  })

  it('stays silent for a skipped version but prompts for the next one', async () => {
    const check = createUpdateChecker(
      fetcherOf(
        { body: { version: 'abc-1', notify: true } },
        { body: { version: 'abc-2', notify: true } },
        { body: { version: 'abc-3', notify: true } },
      ),
    )
    expect(await check()).toBeNull()

    writeSkippedVersion('abc-2')
    expect(await check()).toBeNull()
    expect(await check()).toBe('abc-3')
  })

  it('anchors its own version on the first success, not on a failed attempt', async () => {
    const check = createUpdateChecker(
      fetcherOf(
        { throws: true },
        { body: { version: 'abc-1', notify: true } },
        {
          body: { version: 'abc-2', notify: true },
        },
      ),
    )
    expect(await check()).toBeNull()
    expect(await check()).toBeNull()
    expect(await check()).toBe('abc-2')
  })

  it('swallows network errors, non-2xx responses and unparsable bodies', async () => {
    const seeded = { body: { version: 'abc-1', notify: true } }
    for (const failure of [
      { throws: true },
      { status: 404, body: {} },
      { body: '<!doctype html>' },
      { body: { notify: true } },
    ]) {
      const check = createUpdateChecker(fetcherOf(seeded, failure))
      expect(await check()).toBeNull()
      expect(await check()).toBeNull()
    }
  })
})
