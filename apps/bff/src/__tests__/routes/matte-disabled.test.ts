import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'

process.env.PORT = '0'
process.env.DATABASE_URL = 'postgres://unused/unused'
process.env.MATTE_TRANSFORM_ORIGIN = 'https://bff.example.com'
process.env.OPERATOR_CONFIG_FILE = ''

// Dynamic import keeps environment setup ahead of configuration module evaluation.
const { matteRoutes } = await import('../../routes/matte')
const { setMatteFetchForTesting } = await import('../../lib/matte')

const app = new Elysia().use(matteRoutes)

describe('POST /api/matte without the capability', () => {
  it('answers 404 and never reaches Cloudflare', async () => {
    setMatteFetchForTesting(() => {
      throw new Error('unexpected matte call')
    })

    const response = await app.handle(
      new Request('http://localhost/api/matte', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image: 'data:image/png;base64,AA==' }),
      }),
    )

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: 'capability_unavailable',
      capability: 'matte:server',
    })
    setMatteFetchForTesting()
  })

  it('also keeps the hash probe unavailable', async () => {
    const response = await app.handle(new Request(`http://localhost/api/matte/${'a'.repeat(64)}`))

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: 'capability_unavailable',
      capability: 'matte:server',
    })
  })
})
