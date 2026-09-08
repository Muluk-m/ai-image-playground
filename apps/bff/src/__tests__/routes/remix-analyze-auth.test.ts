import { afterEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { Elysia } from 'elysia'
import { chatCompletion, chatFetchReturning } from '../helpers/chatStubs'

process.env.PORT = '0'
process.env.DATABASE_URL = 'postgres://unused/unused'
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.UPSTREAM_OPENAI_API_KEY = ''
process.env.REMIX_VISION_MODEL = 'fixture-vision-model'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../remix-login-operator-config.json')

// Dynamic import keeps environment setup ahead of configuration module evaluation.
const { remixAnalyzeRoutes } = await import('../../routes/remix-analyze')
const { setChatFetchForTesting } = await import('../../lib/chatCompletion')

const app = new Elysia().use(remixAnalyzeRoutes)

const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const BRIEF = {
  shotType: 'scene',
  composition: 'Tub centred, low horizon.',
  camera: 'Eye level, 35mm.',
  lighting: 'Soft window light from the left.',
  background: 'Warm stone bathroom.',
  props: ['towel'],
  textZones: [],
  palette: ['#e8e2d8'],
  productBox: { x: 0.2, y: 0.3, w: 0.5, h: 0.4 },
  suggestedTitle: 'Freestanding tub in a stone bath',
}

function analyze(headers: Record<string, string> = {}): Promise<Response> {
  return app.handle(
    new Request('http://localhost/api/remix/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({
        images: [PIXEL],
        product: { name: 'Abruzzo tub', description: '' },
      }),
    }),
  )
}

afterEach(() => {
  setChatFetchForTesting()
})

describe('POST /api/remix/analyze with accounts:login enabled', () => {
  it('answers 401 without a session and burns no vision call', async () => {
    const fetchImpl = chatFetchReturning(chatCompletion(JSON.stringify(BRIEF)))
    setChatFetchForTesting(fetchImpl)

    const response = await analyze()

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'unauthorized' })
    expect(fetchImpl).toHaveBeenCalledTimes(0)
  })

  it('accepts the configured service credential', async () => {
    const fetchImpl = chatFetchReturning(chatCompletion(JSON.stringify(BRIEF)))
    setChatFetchForTesting(fetchImpl)

    const response = await analyze({ authorization: 'Bearer fixture-service-credential-alpha' })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ briefs: [BRIEF] })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
