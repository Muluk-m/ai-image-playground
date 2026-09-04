import { describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'

process.env.PORT = '0'
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? ''
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../quota-operator-config.json')

const { app } = await import('../../app')

describe('remix listing routes with the capability disabled', () => {
  it('hides both routes behind capability_unavailable', async () => {
    const listing = await app.handle(
      new Request('http://localhost/api/remix/listing', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://www.amazon.com/dp/B0FVLNS696' }),
      }),
    )
    expect(listing.status).toBe(404)
    expect(await listing.json()).toEqual({
      error: 'capability_unavailable',
      capability: 'remix:listing',
    })

    const image = await app.handle(
      new Request(
        'http://localhost/api/remix/image?url=https%3A%2F%2Fm.media-amazon.com%2Fimages%2FI%2F71a.jpg',
      ),
    )
    expect(image.status).toBe(404)
  })
})
