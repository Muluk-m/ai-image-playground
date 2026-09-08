import { afterEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { Elysia } from 'elysia'
import { HARD_CODED_PARTS } from '../hardCodedParts'
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
const { bgswapPlanRoutes } = await import('../../routes/bgswap-plan')
const { setChatFetchForTesting } = await import('../../lib/chatCompletion')
const { buildBackgroundPrompt } = await import('@image-playground/shared')

const app = new Elysia().use(bgswapPlanRoutes)

const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const PLAN = {
  category: '独立式浴缸',
  camera: '略高于缸沿的 3/4 侧视，标准镜头',
  sceneType: 'photo',
  productBox: { x: 0.2, y: 0.3, w: 0.5, h: 0.4 },
  inventory: ['独立式浴缸', '落地龙头'],
  plan: '暖白微水泥墙面，浅橡木地板，左侧柔和窗光，一株散尾葵与一条亚麻毛巾。',
}

const planned = () => chatCompletion(JSON.stringify(PLAN))

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
  setChatFetchForTesting()
})

describe('POST /api/bgswap/plan', () => {
  it('returns the plan plus a prompt assembled from the server template', async () => {
    const calls: ChatCall[] = []
    setChatFetchForTesting(recordingChatFetch(calls, planned))

    const { status, json } = await plan({ image: PIXEL, preference: '北欧风', language: 'zh' })

    expect(status).toBe(200)
    expect(json).toEqual({
      ...PLAN,
      prompt: buildBackgroundPrompt({
        plan: PLAN.plan,
        sceneType: 'photo',
        inventory: PLAN.inventory,
        preference: '北欧风',
        language: 'zh',
      }),
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://gateway.test/v1/chat/completions')
    expect(calls[0]!.authorization).toBe('Bearer fixture-upstream-key')
    expect(calls[0]!.model).toBe('fixture-vision-model')
    expect(calls[0]!.images).toEqual([PIXEL])
    // 偏好优先于模型自己的判断，所以它必须进视觉提示，而不只是进最终提示词。
    expect(calls[0]!.prompt).toContain('北欧风')
    // 计划句会落进最终提示词的「要换的部分」，复述保留项会读成自相矛盾。
    expect(calls[0]!.prompt).toContain('never restate what stays')
  })

  it('works without a preference and defaults to Chinese', async () => {
    setChatFetchForTesting(chatFetchReturning(chatCompletion(JSON.stringify(PLAN))))

    const { status, json } = await plan({ image: PIXEL })

    expect(status).toBe(200)
    expect(json).toEqual({
      ...PLAN,
      prompt: buildBackgroundPrompt({
        plan: PLAN.plan,
        sceneType: 'photo',
        inventory: PLAN.inventory,
      }),
    })
  })

  it('trims the model answer so the plan label and the prompt carry the same sentence', async () => {
    const padded = { ...PLAN, plan: `  ${PLAN.plan}\n`, category: ' 独立式浴缸 ' }
    setChatFetchForTesting(chatFetchReturning(chatCompletion(JSON.stringify(padded))))

    const { status, json } = await plan({ image: PIXEL })

    expect(status).toBe(200)
    expect(json).toEqual({
      ...PLAN,
      prompt: buildBackgroundPrompt({
        plan: PLAN.plan,
        sceneType: 'photo',
        inventory: PLAN.inventory,
      }),
    })
  })

  it('takes each of the four scene kinds and normalises the wording', async () => {
    for (const [answered, parsed] of [
      ['photo', 'photo'],
      ['Infographic', 'infographic'],
      [' callout ', 'callout'],
      ['collage', 'collage'],
    ]) {
      setChatFetchForTesting(
        chatFetchReturning(chatCompletion(JSON.stringify({ ...PLAN, sceneType: answered }))),
      )

      const { status, json } = await plan({ image: PIXEL })

      expect(status).toBe(200)
      expect(json).toMatchObject({ sceneType: parsed })
    }
  })

  /** 示意图默认被跳过，所以一个认不出的画面类型宁可当没答，也不能悄悄按实拍图走。 */
  it('treats a scene kind outside the four as no answer at all', async () => {
    const fetchImpl = chatFetchReturning(
      chatCompletion(JSON.stringify({ ...PLAN, sceneType: '纯色棚拍' })),
    )
    setChatFetchForTesting(fetchImpl)

    const { status, json } = await plan({ image: PIXEL })

    expect(status).toBe(502)
    expect(json).toEqual({ error: 'vision_invalid_response' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('asks for the surfaces to go only when the image is a plain photo', async () => {
    setChatFetchForTesting(
      chatFetchReturning(chatCompletion(JSON.stringify({ ...PLAN, sceneType: 'infographic' }))),
    )

    const { json } = await plan({ image: PIXEL })

    expect((json as { prompt: string }).prompt).not.toContain('墙面、半墙、台面与地面')
    expect(buildBackgroundPrompt({ plan: PLAN.plan, sceneType: 'photo' })).toContain(
      '墙面、半墙、台面与地面',
    )
  })

  it('accepts a null product box', async () => {
    const noBox = { ...PLAN, productBox: null }
    setChatFetchForTesting(chatFetchReturning(chatCompletion(JSON.stringify(noBox))))

    const { status, json } = await plan({ image: PIXEL })

    expect(status).toBe(200)
    expect(json).toMatchObject({ productBox: null })
  })

  it('retries once when the model answers with something other than a plan', async () => {
    const fetchImpl = chatFetchReturning(
      chatCompletion('sorry, I cannot help'),
      chatCompletion(`\`\`\`json\n${JSON.stringify(PLAN)}\n\`\`\``),
    )
    setChatFetchForTesting(fetchImpl)

    const { status } = await plan({ image: PIXEL })

    expect(status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('fails with 502 when the retry is still not a plan', async () => {
    const fetchImpl = chatFetchReturning(chatCompletion('not json at all'))
    setChatFetchForTesting(fetchImpl)

    const { status, json } = await plan({ image: PIXEL })

    expect(status).toBe(502)
    expect(json).toEqual({ error: 'vision_invalid_response' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('passes an upstream failure through as 502 with the upstream status', async () => {
    setChatFetchForTesting(chatFetchReturning(new Response('rate limited', { status: 429 })))

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

  it('keeps the camera sentence so the client can pick a matching asset angle', async () => {
    setChatFetchForTesting(chatFetchReturning(chatCompletion(JSON.stringify(PLAN))))

    const { json } = await plan({ image: PIXEL })

    expect(json).toMatchObject({ camera: PLAN.camera })
  })

  it('still answers when the model leaves the camera sentence out', async () => {
    const { camera: _camera, ...noCamera } = PLAN
    setChatFetchForTesting(chatFetchReturning(chatCompletion(JSON.stringify(noCamera))))

    const { status, json } = await plan({ image: PIXEL })

    expect(status).toBe(200)
    expect(json).toMatchObject({ camera: '' })
  })

  it('returns the prompt of the mode the client asked for', async () => {
    for (const mode of ['replace-product', 'replace-and-background'] as const) {
      setChatFetchForTesting(chatFetchReturning(chatCompletion(JSON.stringify(PLAN))))

      const { status, json } = await plan({ image: PIXEL, mode })

      expect(status).toBe(200)
      expect(json).toEqual({
        ...PLAN,
        prompt: buildBackgroundPrompt({
          plan: PLAN.plan,
          sceneType: 'photo',
          inventory: PLAN.inventory,
          mode,
        }),
      })
    }
  })

  it('still answers, with the generic untouched clause, when the model lists no inventory', async () => {
    const { inventory: _inventory, ...noInventory } = PLAN
    setChatFetchForTesting(chatFetchReturning(chatCompletion(JSON.stringify(noInventory))))

    const { status, json } = await plan({ image: PIXEL })

    expect(status).toBe(200)
    expect(json).toMatchObject({ inventory: [] })
    expect((json as { prompt: string }).prompt).toContain('产品本身及所有功能上属于它的部件')
  })

  it('asks the model for the inventory before the plan sentence', async () => {
    const calls: ChatCall[] = []
    setChatFetchForTesting(recordingChatFetch(calls, planned))

    await plan({ image: PIXEL })

    const sent = calls[0]!.prompt
    expect(sent).toContain('"inventory"')
    expect(sent.indexOf('"inventory"')).toBeLessThan(sent.indexOf('"plan"'))
  })

  it('makes the inventory a matter of function, not of touching the product', async () => {
    const calls: ChatCall[] = []
    setChatFetchForTesting(recordingChatFetch(calls, planned))

    await plan({ image: PIXEL })

    expect(calls[0]!.prompt).toMatch(/functionally belongs/)
    expect(calls[0]!.prompt).toMatch(/whether or not it touches/)
  })

  it('asks for props that lift on their own and duplicate nothing on the inventory', async () => {
    const calls: ChatCall[] = []
    setChatFetchForTesting(recordingChatFetch(calls, planned))

    await plan({ image: PIXEL })

    const sent = calls[0]!.prompt
    expect(sent).toMatch(/liftable on its own/)
    expect(sent).toMatch(/must not appear in "inventory"/)
    expect(sent).toMatch(/must not repeat the function/)
  })

  it('names no part type of its own, so the inventory stays the model answer', async () => {
    const calls: ChatCall[] = []
    setChatFetchForTesting(recordingChatFetch(calls, planned))

    await plan({ image: PIXEL })

    expect(calls[0]!.prompt).not.toMatch(HARD_CODED_PARTS)
  })

  it('tells the model that a must-keep in the preference joins the inventory', async () => {
    const calls: ChatCall[] = []
    setChatFetchForTesting(recordingChatFetch(calls, planned))

    await plan({ image: PIXEL, preference: '保留原有的落地龙头' })

    expect(calls[0]!.prompt).toContain('保留原有的落地龙头')
    expect(calls[0]!.prompt).toMatch(/must-keep[\s\S]*"inventory"/)
  })

  it('rejects a mode outside the three', async () => {
    expect((await plan({ image: PIXEL, mode: 'erase-product' })).status).toBe(400)
  })
})

describe('POST /api/bgswap/scan', () => {
  it('answers with the scene kind alone', async () => {
    setChatFetchForTesting(
      chatFetchReturning(chatCompletion(JSON.stringify({ sceneType: 'infographic' }))),
    )

    const { status, json } = await scan({ image: PIXEL })

    expect(status).toBe(200)
    expect(json).toEqual({ sceneType: 'infographic' })
  })

  it('fails with 502 when the model never names one of the four', async () => {
    const fetchImpl = chatFetchReturning(chatCompletion(JSON.stringify({ sceneType: '说明图' })))
    setChatFetchForTesting(fetchImpl)

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
