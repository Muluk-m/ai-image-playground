import { afterEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'

process.env.PORT = '0'
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? ''
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../remix-operator-config.json')

const { app } = await import('../../app')
const { setListingFetchForTesting } = await import('../../lib/listingFetch')
type TestFetch = NonNullable<Parameters<typeof setListingFetchForTesting>[0]>

const listingHtml = `<html><body>
<span id="productTitle">Abruzzo Freestanding Bathtub</span>
<script>[{"hiRes":"https://m.media-amazon.com/images/I/71aaaaaaaaL._AC_SL1500_.jpg"},{"hiRes":"https://m.media-amazon.com/images/I/71bbbbbbbbL._AC_SL1500_.jpg"}]</script>
</body></html>`

const captchaHtml = `<html><body><h4>Enter the characters you see below</h4>
<img src="https://images-na.ssl-images-amazon.com/images/G/01/nav/logo._CB1_.png"></body></html>`

function stubFetch(handler: (url: string, init: { headers?: Record<string, string> }) => Response) {
  const calls: { url: string; headers: Record<string, string> }[] = []
  setListingFetchForTesting(((input: unknown, init?: { headers?: Record<string, string> }) => {
    const url = String(input)
    calls.push({ url, headers: init?.headers ?? {} })
    return Promise.resolve(handler(url, init ?? {}))
  }) as unknown as TestFetch)
  return calls
}

function post(url: unknown): Promise<Response> {
  return app.handle(
    new Request('http://localhost/api/remix/listing', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    }),
  )
}

function getImage(url: string): Promise<Response> {
  return app.handle(new Request(`http://localhost/api/remix/image?url=${encodeURIComponent(url)}`))
}

afterEach(() => {
  setListingFetchForTesting()
})

describe('POST /api/remix/listing', () => {
  it('fetches the canonical product page with browser headers and returns its gallery', async () => {
    const calls = stubFetch(
      () => new Response(listingHtml, { headers: { 'content-type': 'text/html' } }),
    )

    const response = await post('https://www.amazon.com/Abruzzo/dp/B0FVLNS696/ref=sr_1_3?th=1')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      asin: 'B0FVLNS696',
      title: 'Abruzzo Freestanding Bathtub',
      images: [
        'https://m.media-amazon.com/images/I/71aaaaaaaaL._AC_SL1500_.jpg',
        'https://m.media-amazon.com/images/I/71bbbbbbbbL._AC_SL1500_.jpg',
      ],
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://www.amazon.com/dp/B0FVLNS696')
    expect(calls[0]!.headers['user-agent']).toContain('Mozilla/5.0')
    expect(calls[0]!.headers['accept-language']).toContain('en')
  })

  it('rejects URLs that are not amazon product pages without fetching them', async () => {
    const calls = stubFetch(() => new Response('unexpected', { status: 200 }))

    for (const url of ['https://example.com/dp/B0FVLNS696', 'https://www.amazon.com/s?k=tub']) {
      const response = await post(url)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: 'unsupported_listing_url' })
    }

    const malformed = await post(42)
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toMatchObject({ error: 'invalid_request' })
    expect(calls).toHaveLength(0)
  })

  it('reports listing_unavailable when the page is an anti-bot challenge', async () => {
    stubFetch(() => new Response(captchaHtml, { headers: { 'content-type': 'text/html' } }))

    const response = await post('https://www.amazon.com/dp/B0FVLNS696')
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'listing_unavailable' })
  })

  it('reports listing_unavailable when amazon refuses the request', async () => {
    stubFetch(() => new Response('blocked', { status: 503 }))

    const response = await post('https://www.amazon.com/dp/B0FVLNS696')
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'listing_unavailable' })
  })
})

describe('GET /api/remix/image', () => {
  it('proxies bytes from amazon image hosts with a private cache header', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    stubFetch(() => new Response(bytes, { headers: { 'content-type': 'image/png' } }))

    const response = await getImage('https://m.media-amazon.com/images/I/71aaaaaaaaL.jpg')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('cache-control')).toBe('private, max-age=3600')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
  })

  it('refuses hosts outside the amazon image allowlist and plain http', async () => {
    const calls = stubFetch(() => new Response(new Uint8Array([1])))

    for (const url of [
      'https://evil.example/images/I/71a.jpg',
      'https://m.media-amazon.com.evil.example/images/I/71a.jpg',
      'http://m.media-amazon.com/images/I/71a.jpg',
      'not-a-url',
    ]) {
      const response = await getImage(url)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: 'image_host_not_allowed' })
    }
    expect(calls).toHaveLength(0)
  })

  it('refuses responses that are oversized or not images', async () => {
    stubFetch(
      () =>
        new Response(new Uint8Array([1]), {
          headers: { 'content-type': 'image/jpeg', 'content-length': String(21 * 1024 * 1024) },
        }),
    )
    const oversized = await getImage('https://m.media-amazon.com/images/I/71aaaaaaaaL.jpg')
    expect(oversized.status).toBe(502)
    expect(await oversized.json()).toEqual({ error: 'image_unavailable' })

    for (const contentType of ['text/html', 'image/svg+xml']) {
      stubFetch(
        () =>
          new Response('<svg onload="alert(1)"/>', { headers: { 'content-type': contentType } }),
      )
      const notProxyable = await getImage('https://m.media-amazon.com/images/I/71aaaaaaaaL.jpg')
      expect(notProxyable.status).toBe(502)
    }
  })
})
