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

describe('the bgswap vision routes without the capability', () => {
  it('answer 404 and never reach the gateway', async () => {
    setVisionFetchForTesting(() => {
      throw new Error('unexpected vision call')
    })

    for (const path of ['/api/bgswap/plan', '/api/bgswap/scan']) {
      const response = await app.handle(
        new Request(`http://localhost${path}`, {
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
    }
    setVisionFetchForTesting()
  })
})
