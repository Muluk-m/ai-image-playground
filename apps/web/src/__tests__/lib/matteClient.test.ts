import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestServerMatte } from '../../lib/matteClient'
import { _setRuntimeConfigForTesting } from '../../lib/runtimeConfig'

const IMAGE = 'data:image/png;base64,YWJj'
// SHA-256 of the decoded bytes "abc", not of the data URL or its base64 text.
const HASH = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
const ENDPOINT = 'https://bff.example.com/api/matte'
const MATTE = {
  alpha: 'data:image/png;base64,AAA',
  backend: 'cloudflare-birefnet',
  cached: false,
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'https://bff.example.com/' } })
})

afterEach(() => {
  _setRuntimeConfigForTesting({ bff: { enabled: false, baseUrl: '' } })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('asking the BFF to matte the product', () => {
  it('returns a content-hash hit without uploading image bytes', async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url !== `${ENDPOINT}/${HASH}` || init?.body) throw new Error('unexpected upload')
      return jsonResponse({ ...MATTE, cached: true })
    })

    await expect(requestServerMatte(IMAGE, fetcher)).resolves.toEqual({ ...MATTE, cached: true })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('uploads exactly once after a cache miss', async () => {
    const requests: { url: string; body?: BodyInit | null }[] = []
    const fetcher = async (url: string, init?: RequestInit) => {
      requests.push({ url, body: init?.body })
      return url.endsWith(`/${HASH}`)
        ? jsonResponse({ error: 'not_found' }, 404)
        : jsonResponse(MATTE)
    }

    await expect(requestServerMatte(IMAGE, fetcher)).resolves.toEqual(MATTE)
    expect(requests).toEqual([
      { url: `${ENDPOINT}/${HASH}`, body: undefined },
      { url: ENDPOINT, body: JSON.stringify({ image: IMAGE }) },
    ])
  })

  it('does not upload after an authentication failure', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 401))

    await expect(requestServerMatte(IMAGE, fetcher)).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('rejects a successful response that is not a matte', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ alpha: 'not-a-data-url' }))

    await expect(requestServerMatte(IMAGE, fetcher)).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('retains the upload path without Web Crypto on an insecure LAN origin', async () => {
    vi.stubGlobal('crypto', undefined)
    const fetcher = async (url: string, init?: RequestInit) => {
      if (url !== ENDPOINT || !init?.body) throw new Error('unexpected cache probe')
      return jsonResponse(MATTE)
    }

    await expect(requestServerMatte(IMAGE, fetcher)).resolves.toEqual(MATTE)
  })
})
