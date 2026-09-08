import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'

process.env.PORT = '0'
process.env.DATABASE_URL = 'postgres://unused/unused'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.OPERATOR_CONFIG_FILE = ''

// Dynamic import keeps environment setup ahead of configuration module evaluation.
const { storyboardPlanRoutes } = await import('../../routes/storyboard-plan')
const { setChatFetchForTesting } = await import('../../lib/chatCompletion')

const app = new Elysia().use(storyboardPlanRoutes)

describe('the storyboard route without the capability', () => {
  it('answers 404 and never reaches the gateway', async () => {
    setChatFetchForTesting(() => {
      throw new Error('unexpected storyboard call')
    })

    const response = await app.handle(
      new Request('http://localhost/api/storyboard/plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          idea: '一支讲通勤咖啡的短片',
          shots: 2,
          secondsPerShot: 5,
          aspectRatio: '9:16',
        }),
      }),
    )

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: 'capability_unavailable',
      capability: 'generation:storyboard',
    })
    setChatFetchForTesting()
  })
})
