import { afterEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { Elysia } from 'elysia'
import {
  type ChatCall,
  chatCompletion,
  chatFetchReturning,
  recordingChatFetch,
} from '../helpers/chatStubs'

process.env.PORT = '0'
process.env.DATABASE_URL = 'postgres://unused/unused'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.UPSTREAM_OPENAI_API_KEY = ''
process.env.REMIX_VISION_MODEL = 'fixture-vision-model'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../remix-operator-config.json')

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
  props: ['towel', 'plant'],
  textZones: ['top left headline'],
  palette: ['#e8e2d8', '#3a3a38'],
  productBox: { x: 0.2, y: 0.3, w: 0.5, h: 0.4 },
  suggestedTitle: 'Freestanding tub in a stone bath',
}

async function analyze(body: unknown) {
  const response = await app.handle(
    new Request('http://localhost/api/remix/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
  return { status: response.status, json: await response.json() }
}

afterEach(() => {
  setChatFetchForTesting()
})

describe('POST /api/remix/analyze', () => {
  it('returns one brief per image and calls the gateway chat endpoint', async () => {
    const calls: ChatCall[] = []
    setChatFetchForTesting(recordingChatFetch(calls, () => chatCompletion(JSON.stringify(BRIEF))))

    const { status, json } = await analyze({
      images: [PIXEL, PIXEL],
      product: { name: 'Abruzzo tub', description: 'freestanding acrylic bathtub' },
    })

    expect(status).toBe(200)
    expect(json).toEqual({ briefs: [BRIEF, BRIEF] })
    expect(calls).toHaveLength(2)
    expect(calls[0]!.url).toBe('http://gateway.test/v1/chat/completions')
    expect(calls[0]!.authorization).toBe('Bearer fixture-upstream-key')
    expect(calls[0]!.model).toBe('fixture-vision-model')
    expect(calls[0]!.images).toEqual([PIXEL])
  })

  it('retries once when the model answers with something other than a brief', async () => {
    const fetchImpl = chatFetchReturning(
      chatCompletion('sorry, I cannot help'),
      chatCompletion(`\`\`\`json\n${JSON.stringify(BRIEF)}\n\`\`\``),
    )
    setChatFetchForTesting(fetchImpl)

    const { status, json } = await analyze({
      images: [PIXEL],
      product: { name: 'Abruzzo tub', description: '' },
    })

    expect(status).toBe(200)
    expect(json).toEqual({ briefs: [BRIEF] })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('fails with 502 when the retry is still not a brief', async () => {
    const fetchImpl = chatFetchReturning(chatCompletion('not json at all'))
    setChatFetchForTesting(fetchImpl)

    const { status, json } = await analyze({
      images: [PIXEL],
      product: { name: 'Abruzzo tub', description: '' },
    })

    expect(status).toBe(502)
    expect(json).toEqual({ error: 'vision_invalid_response' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('passes an upstream failure through as 502 with the upstream status', async () => {
    setChatFetchForTesting(chatFetchReturning(new Response('rate limited', { status: 429 })))

    const { status, json } = await analyze({
      images: [PIXEL],
      product: { name: 'Abruzzo tub', description: '' },
    })

    expect(status).toBe(502)
    expect(json).toEqual({ error: 'vision_upstream_error', upstream_status: 429 })
  })

  it('rejects a request without images or with something other than an image data URL', async () => {
    const empty = await analyze({ images: [], product: { name: 'x', description: '' } })
    expect(empty.status).toBe(400)
    expect(empty.json).toMatchObject({ error: 'invalid_request' })

    const notADataUrl = await analyze({
      images: ['https://example.com/a.jpg'],
      product: { name: 'x', description: '' },
    })
    expect(notADataUrl.status).toBe(400)
  })
})
