import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { Elysia } from 'elysia'

process.env.PORT = '0'
process.env.DATABASE_URL = 'postgres://unused/unused'
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
// Trailing slash proves the origin is normalised before it lands in the transform URL.
process.env.MATTE_TRANSFORM_ORIGIN = 'https://bff.example.com/'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../matte-operator-config.json')

// Dynamic import keeps environment setup ahead of configuration module evaluation.
const { matteRoutes } = await import('../../routes/matte')
const { mintSourceToken, setMatteFetchForTesting } = await import('../../lib/matte')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { InMemoryObjectStore } = await import('../helpers/inMemoryObjectStore')

type MatteFetch = NonNullable<Parameters<typeof setMatteFetchForTesting>[0]>

const app = new Elysia().use(matteRoutes)

const SOURCE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const SOURCE_IMAGE = `data:image/png;base64,${SOURCE_BASE64}`
const SOURCE_BYTES = Buffer.from(SOURCE_BASE64, 'base64')
const SOURCE_HASH = createHash('sha256').update(SOURCE_BYTES).digest('hex')
const ALPHA_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x61, 0x6c])

const URL_PREFIX =
  'https://bff.example.com/cdn-cgi/image/segment=foreground,format=png/https://bff.example.com/api/matte/source/'

let store: InstanceType<typeof InMemoryObjectStore>

beforeEach(() => {
  store = new InMemoryObjectStore()
  setObjectStoreForTesting(store)
})

afterEach(() => {
  setObjectStoreForTesting()
  setMatteFetchForTesting()
})

function segmentedPng(headers: Record<string, string> = {}): Response {
  return new Response(ALPHA_BYTES, {
    status: 200,
    headers: { 'content-type': 'image/png', 'cf-resized': 'internal stats=1', ...headers },
  })
}

function matteFetchReturning(response: () => Response, urls: string[] = []): MatteFetch {
  return mock(async (url: unknown) => {
    urls.push(String(url))
    return response()
  }) as unknown as MatteFetch
}

function postImage(image: string): Promise<Response> {
  return app.handle(
    new Request('http://localhost/api/matte', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image }),
    }),
  )
}

function getSource(token: string): Promise<Response> {
  return app.handle(new Request(`http://localhost/api/matte/source/${token}`))
}

describe('POST /api/matte', () => {
  it('segments through the transform URL and hands the token the source bytes', async () => {
    const urls: string[] = []
    setMatteFetchForTesting(matteFetchReturning(segmentedPng, urls))

    const response = await postImage(SOURCE_IMAGE)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      alpha: `data:image/png;base64,${ALPHA_BYTES.toString('base64')}`,
      backend: 'cloudflare-birefnet',
      cached: false,
    })
    expect(urls).toHaveLength(1)
    expect(urls[0]!.startsWith(URL_PREFIX)).toBe(true)

    const source = await getSource(urls[0]!.slice(URL_PREFIX.length))
    expect(source.status).toBe(200)
    expect(source.headers.get('content-type')).toBe('image/png')
    expect(source.headers.get('cache-control')).toBe('private, max-age=300')
    expect(new Uint8Array(await source.arrayBuffer())).toEqual(new Uint8Array(SOURCE_BYTES))
    expect(store.objects.has(`matte/${SOURCE_HASH}/alpha.png`)).toBe(true)
  })

  it('answers a stored alpha without calling Cloudflare again', async () => {
    const urls: string[] = []
    setMatteFetchForTesting(matteFetchReturning(segmentedPng, urls))
    await postImage(SOURCE_IMAGE)

    const response = await postImage(SOURCE_IMAGE)

    expect(await response.json()).toEqual({
      alpha: `data:image/png;base64,${ALPHA_BYTES.toString('base64')}`,
      backend: 'cloudflare-birefnet',
      cached: true,
    })
    expect(urls).toHaveLength(1)
  })

  it('answers 502 when the transform returns something other than a usable PNG', async () => {
    const cases: Array<() => Response> = [
      () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      () => segmentedPng({ 'cf-resized': 'err=9422' }),
      () => new Response('', { status: 503, headers: { 'content-type': 'text/plain' } }),
    ]

    for (const body of cases) {
      store.objects.clear()
      setMatteFetchForTesting(matteFetchReturning(body))
      const response = await postImage(SOURCE_IMAGE)
      expect(response.status).toBe(502)
      expect(await response.json()).toEqual({ error: 'matte_upstream_error' })
      expect(store.objects.has(`matte/${SOURCE_HASH}/alpha.png`)).toBe(false)
    }
  })

  it('answers 502 when the transform request aborts', async () => {
    setMatteFetchForTesting(
      mock(async () => {
        throw new DOMException('Aborted', 'AbortError')
      }) as unknown as MatteFetch,
    )

    const response = await postImage(SOURCE_IMAGE)

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'matte_upstream_error' })
  })

  it('answers 400 for an oversized body', async () => {
    setMatteFetchForTesting(
      mock(async () => {
        throw new Error('unexpected matte call')
      }) as unknown as MatteFetch,
    )

    const response = await postImage(`data:image/png;base64,${'A'.repeat(4_000_001)}`)

    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toBe('invalid_request')
  })
})

describe('GET /api/matte/source/:token', () => {
  const key = `matte/${SOURCE_HASH}/source.png`

  beforeEach(async () => {
    await store.write(key, SOURCE_BYTES, 'image/png')
  })

  it('rejects expired, tampered and out-of-prefix tokens', async () => {
    const expired = mintSourceToken(key, Date.now() - 10 * 60 * 1000)
    const valid = mintSourceToken(key)
    const tampered = `${valid.split('.')[0]}.${'A'.repeat(valid.split('.')[1]!.length)}`
    const elsewhere = mintSourceToken('task-1/in/0')

    for (const token of [expired, tampered, elsewhere, 'not-a-token']) {
      const response = await getSource(token)
      expect(response.status).toBe(404)
    }
  })
})
