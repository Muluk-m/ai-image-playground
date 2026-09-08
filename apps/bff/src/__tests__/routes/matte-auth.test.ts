import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { resolve } from 'node:path'
import { Elysia } from 'elysia'

process.env.PORT = '0'
process.env.DATABASE_URL = 'postgres://unused/unused'
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.MATTE_TRANSFORM_ORIGIN = 'https://bff.example.com'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../matte-login-operator-config.json')

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
const ALPHA_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x61, 0x6c])

let store: InstanceType<typeof InMemoryObjectStore>

beforeEach(() => {
  store = new InMemoryObjectStore()
  setObjectStoreForTesting(store)
})

afterEach(() => {
  setObjectStoreForTesting()
  setMatteFetchForTesting()
})

function injectMatteFetch() {
  const fetcher = mock<MatteFetch>(
    async () =>
      new Response(ALPHA_BYTES, {
        status: 200,
        headers: { 'content-type': 'image/png', 'cf-resized': 'internal stats=1' },
      }),
  )
  setMatteFetchForTesting(fetcher)
  return fetcher
}

function postImage(headers: Record<string, string> = {}): Promise<Response> {
  return app.handle(
    new Request('http://localhost/api/matte', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ image: SOURCE_IMAGE }),
    }),
  )
}

describe('POST /api/matte with accounts:login enabled', () => {
  it('answers 401 without a session and burns no upstream transform or storage', async () => {
    const fetcher = injectMatteFetch()

    const response = await postImage()

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'unauthorized' })
    expect(fetcher.mock.calls).toHaveLength(0)
    expect(store.objects.size).toBe(0)
  })

  it('accepts the configured service credential', async () => {
    const fetcher = injectMatteFetch()

    const response = await postImage({ authorization: 'Bearer fixture-service-credential-alpha' })

    expect(response.status).toBe(200)
    expect(((await response.json()) as { backend: string }).backend).toBe('cloudflare-birefnet')
    expect(fetcher.mock.calls).toHaveLength(1)
  })
})

describe('GET /api/matte/source/:token with accounts:login enabled', () => {
  it('stays reachable without a cookie so Cloudflare can fetch the source', async () => {
    const key = `matte/${'a'.repeat(64)}/source.png`
    await store.write(key, Buffer.from(SOURCE_BASE64, 'base64'), 'image/png')

    const response = await app.handle(
      new Request(`http://localhost/api/matte/source/${mintSourceToken(key)}`),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
  })
})
