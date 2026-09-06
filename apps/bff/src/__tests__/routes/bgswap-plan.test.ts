import { afterEach, describe, expect, it, mock } from 'bun:test'
import { resolve } from 'node:path'
import { Elysia } from 'elysia'

process.env.PORT = '0'
process.env.DATABASE_URL = 'postgres://unused/unused'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.UPSTREAM_OPENAI_API_KEY = ''
process.env.REMIX_VISION_MODEL = 'fixture-vision-model'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../remix-operator-config.json')

// Dynamic import keeps environment setup ahead of configuration module evaluation.
const { bgswapPlanRoutes } = await import('../../routes/bgswap-plan')
const { setVisionFetchForTesting } = await import('../../lib/vision')
const { buildBackgroundPrompt } = await import('../../lib/bgswapPrompt')

type VisionFetch = NonNullable<Parameters<typeof setVisionFetchForTesting>[0]>

const app = new Elysia().use(bgswapPlanRoutes)

const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const PLAN = {
  category: '独立式浴缸',
  sceneType: 'photo',
  productBox: { x: 0.2, y: 0.3, w: 0.5, h: 0.4 },
  plan: '暖白微水泥墙面，浅橡木地板，左侧柔和窗光，一株散尾葵与一条亚麻毛巾。',
}

function chatCompletion(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function visionFetchReturning(...bodies: Response[]): VisionFetch {
  let index = 0
  return mock(async () => {
    const body = bodies[Math.min(index, bodies.length - 1)]!
    index += 1
    return body.clone()
  }) as unknown as VisionFetch
}

async function scan(body: unknown) {
  const response = await app.handle(
    new Request('http://localhost/api/bgswap/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
  return { status: response.status, json: await response.json() }
}

async function plan(body: unknown) {
  const response = await app.handle(
    new Request('http://localhost/api/bgswap/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
  return { status: response.status, json: await response.json() }
}

afterEach(() => {
  setVisionFetchForTesting()
})

describe('POST /api/bgswap/plan', () => {
  it('returns the plan plus a prompt assembled from the server template', async () => {
    const calls: { url: string; init: unknown }[] = []
    setVisionFetchForTesting(
      mock(async (url: unknown, init: unknown) => {
        calls.push({ url: String(url), init })
        return chatCompletion(JSON.stringify(PLAN))
      }) as unknown as VisionFetch,
    )

    const { status, json } = await plan({ image: PIXEL, preference: '北欧风', language: 'zh' })

    expect(status).toBe(200)
    expect(json).toEqual({
      ...PLAN,
      prompt: buildBackgroundPrompt({
        plan: PLAN.plan,
        sceneType: 'photo',
        preference: '北欧风',
        language: 'zh',
      }),
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://gateway.test/v1/chat/completions')
    const init = calls[0]!.init as { headers: Record<string, string>; body: string }
    expect(init.headers.authorization).toBe('Bearer fixture-upstream-key')
    const sent = JSON.parse(init.body) as {
      model: string
      messages: { content: { type: string; text?: string; image_url?: { url: string } }[] }[]
    }
    expect(sent.model).toBe('fixture-vision-model')
    const parts = sent.messages[0]!.content
    expect(parts.some((part) => part.type === 'image_url' && part.image_url?.url === PIXEL)).toBe(
      true,
    )
    // 偏好优先于模型自己的判断，所以它必须进视觉提示，而不只是进最终提示词。
    expect(parts.find((part) => part.type === 'text')?.text).toContain('北欧风')
  })

  it('works without a preference and defaults to Chinese', async () => {
    setVisionFetchForTesting(visionFetchReturning(chatCompletion(JSON.stringify(PLAN))))

    const { status, json } = await plan({ image: PIXEL })

    expect(status).toBe(200)
    expect(json).toEqual({
      ...PLAN,
      prompt: buildBackgroundPrompt({ plan: PLAN.plan, sceneType: 'photo' }),
    })
  })

  it('trims the model answer so the plan label and the prompt carry the same sentence', async () => {
    const padded = { ...PLAN, plan: `  ${PLAN.plan}\n`, category: ' 独立式浴缸 ' }
    setVisionFetchForTesting(visionFetchReturning(chatCompletion(JSON.stringify(padded))))

    const { status, json } = await plan({ image: PIXEL })

    expect(status).toBe(200)
    expect(json).toEqual({
      ...PLAN,
      prompt: buildBackgroundPrompt({ plan: PLAN.plan, sceneType: 'photo' }),
    })
  })

  it('takes each of the four scene kinds and normalises the wording', async () => {
    for (const [answered, parsed] of [
      ['photo', 'photo'],
      ['Infographic', 'infographic'],
      [' callout ', 'callout'],
      ['collage', 'collage'],
    ]) {
      setVisionFetchForTesting(
        visionFetchReturning(chatCompletion(JSON.stringify({ ...PLAN, sceneType: answered }))),
      )

      const { status, json } = await plan({ image: PIXEL })

      expect(status).toBe(200)
      expect(json).toMatchObject({ sceneType: parsed })
    }
  })

  /** 示意图默认被跳过，所以一个认不出的画面类型宁可当没答，也不能悄悄按实拍图走。 */
  it('treats a scene kind outside the four as no answer at all', async () => {
    const fetchImpl = visionFetchReturning(
      chatCompletion(JSON.stringify({ ...PLAN, sceneType: '纯色棚拍' })),
    )
    setVisionFetchForTesting(fetchImpl)

    const { status, json } = await plan({ image: PIXEL })

    expect(status).toBe(502)
    expect(json).toEqual({ error: 'vision_invalid_response' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('asks for the surfaces to go only when the image is a plain photo', async () => {
    setVisionFetchForTesting(
      visionFetchReturning(chatCompletion(JSON.stringify({ ...PLAN, sceneType: 'infographic' }))),
    )

    const { json } = await plan({ image: PIXEL })

    expect((json as { prompt: string }).prompt).not.toContain('墙面、半墙、台面与地面')
    expect(buildBackgroundPrompt({ plan: PLAN.plan, sceneType: 'photo' })).toContain(
      '墙面、半墙、台面与地面',
    )
  })

  it('accepts a null product box', async () => {
    const noBox = { ...PLAN, productBox: null }
    setVisionFetchForTesting(visionFetchReturning(chatCompletion(JSON.stringify(noBox))))

    const { status, json } = await plan({ image: PIXEL })

    expect(status).toBe(200)
    expect(json).toMatchObject({ productBox: null })
  })

  it('retries once when the model answers with something other than a plan', async () => {
    const fetchImpl = visionFetchReturning(
      chatCompletion('sorry, I cannot help'),
      chatCompletion(`\`\`\`json\n${JSON.stringify(PLAN)}\n\`\`\``),
    )
    setVisionFetchForTesting(fetchImpl)

    const { status } = await plan({ image: PIXEL })

    expect(status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('fails with 502 when the retry is still not a plan', async () => {
    const fetchImpl = visionFetchReturning(chatCompletion('not json at all'))
    setVisionFetchForTesting(fetchImpl)

    const { status, json } = await plan({ image: PIXEL })

    expect(status).toBe(502)
    expect(json).toEqual({ error: 'vision_invalid_response' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('passes an upstream failure through as 502 with the upstream status', async () => {
    setVisionFetchForTesting(visionFetchReturning(new Response('rate limited', { status: 429 })))

    const { status, json } = await plan({ image: PIXEL })

    expect(status).toBe(502)
    expect(json).toEqual({ error: 'vision_upstream_error', upstream_status: 429 })
  })

  it('rejects a missing image, a non-data-URL image and an unknown language', async () => {
    const missing = await plan({ preference: 'x' })
    expect(missing.status).toBe(400)
    expect(missing.json).toMatchObject({ error: 'invalid_request' })

    const notADataUrl = await plan({ image: 'https://example.com/a.jpg' })
    expect(notADataUrl.status).toBe(400)

    const badLanguage = await plan({ image: PIXEL, language: 'fr' })
    expect(badLanguage.status).toBe(400)
  })
})

describe('POST /api/bgswap/scan', () => {
  it('answers with the scene kind alone', async () => {
    setVisionFetchForTesting(
      visionFetchReturning(chatCompletion(JSON.stringify({ sceneType: 'infographic' }))),
    )

    const { status, json } = await scan({ image: PIXEL })

    expect(status).toBe(200)
    expect(json).toEqual({ sceneType: 'infographic' })
  })

  it('fails with 502 when the model never names one of the four', async () => {
    const fetchImpl = visionFetchReturning(chatCompletion(JSON.stringify({ sceneType: '说明图' })))
    setVisionFetchForTesting(fetchImpl)

    const { status, json } = await scan({ image: PIXEL })

    expect(status).toBe(502)
    expect(json).toEqual({ error: 'vision_invalid_response' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('rejects a body without a data-URL image', async () => {
    expect((await scan({})).status).toBe(400)
    expect((await scan({ image: 'https://example.com/a.jpg' })).status).toBe(400)
  })
})
