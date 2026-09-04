import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'

process.env.PORT = '0'
process.env.DATABASE_URL = 'postgres://unused/unused'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.OPERATOR_CONFIG_FILE = ''

// Dynamic import keeps environment setup ahead of configuration module evaluation.
const { bgswapPlanRoutes } = await import('../../routes/bgswap-plan')
const { setVisionFetchForTesting } = await import('../../lib/vision')

const app = new Elysia().use(bgswapPlanRoutes)

describe('POST /api/bgswap/plan without the capability', () => {
  it('answers 404 and never reaches the gateway', async () => {
    setVisionFetchForTesting(() => {
      throw new Error('unexpected vision call')
    })

    const response = await app.handle(
      new Request('http://localhost/api/bgswap/plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image: 'data:image/png;base64,AA==' }),
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
