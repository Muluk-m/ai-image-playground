import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'

process.env.PORT = '0'
process.env.DATABASE_URL = 'postgres://unused/unused'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.OPERATOR_CONFIG_FILE = ''

// Dynamic import keeps environment setup ahead of configuration module evaluation.
const { remixAnalyzeRoutes } = await import('../../routes/remix-analyze')
const { setVisionFetchForTesting } = await import('../../lib/vision')

const app = new Elysia().use(remixAnalyzeRoutes)

describe('POST /api/remix/analyze without the capability', () => {
  it('answers 404 and never reaches the gateway', async () => {
    setVisionFetchForTesting(() => {
      throw new Error('unexpected vision call')
    })

    const response = await app.handle(
      new Request('http://localhost/api/remix/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          images: ['data:image/png;base64,AA=='],
          product: { name: 'Abruzzo tub', description: '' },
        }),
      }),
    )

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: 'capability_unavailable',
      capability: 'remix:analyze',
    })
    setVisionFetchForTesting()
  })
})
