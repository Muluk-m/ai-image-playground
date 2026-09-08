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
process.env.STORYBOARD_MODEL = 'fixture-storyboard-model'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../storyboard-operator-config.json')

// Dynamic import keeps environment setup ahead of configuration module evaluation.
const { storyboardPlanRoutes } = await import('../../routes/storyboard-plan')
const { setChatFetchForTesting } = await import('../../lib/chatCompletion')

const app = new Elysia().use(storyboardPlanRoutes)

const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const REQUEST = { idea: '一支讲通勤咖啡的短片', shots: 2, totalSeconds: 15, aspectRatio: '9:16' }

function shot(no: number) {
  return {
    no,
    title: `第 ${no} 镜`,
    description: '主角在清晨的地铁口捧着纸杯',
    camera: '缓慢推进',
    line: no === 1 ? '又是一天。' : '',
    imagePrompt: 'commuter holding a paper cup at a subway entrance, morning light, 9:16',
    videoPrompt: 'slow push in, steam rises, the sun climbs across their face',
  }
}

const PLAN = {
  title: '通勤第一口',
  summary: '两镜讲清一杯咖啡的早晨',
  videoPrompt: '通勤者捧着纸杯，清晨地铁口，暖调胶片\n镜头1（0-7.5秒）：推门而出，缓慢推进',
  shots: [shot(1), shot(2)],
}

/** 应答里的时间段由请求参数定，不看模型写了什么。 */
const TIMED = {
  ...PLAN,
  shots: [
    { ...shot(1), startSeconds: 0, seconds: 7.5 },
    { ...shot(2), startSeconds: 7.5, seconds: 7.5 },
  ],
}

const planned = () => chatCompletion(JSON.stringify(PLAN))

async function plan(body: unknown) {
  const response = await app.handle(
    new Request('http://localhost/api/storyboard/plan', {
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

describe('POST /api/storyboard/plan', () => {
  it('answers with the plan the model returned', async () => {
    const calls: ChatCall[] = []
    setChatFetchForTesting(recordingChatFetch(calls, planned))

    const { status, json } = await plan(REQUEST)

    expect(status).toBe(200)
    expect(json).toEqual({ plan: TIMED })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://gateway.test/v1/chat/completions')
    expect(calls[0]!.authorization).toBe('Bearer fixture-upstream-key')
    expect(calls[0]!.model).toBe('fixture-storyboard-model')
    // 没有参考图时是纯文本消息，多塞一个空的图片块会让部分网关直接 400。
    expect(calls[0]!.images).toEqual([])
  })

  it('sends the reference image alongside the prompt when one is attached', async () => {
    const calls: ChatCall[] = []
    setChatFetchForTesting(recordingChatFetch(calls, planned))

    const { status } = await plan({ ...REQUEST, referenceImage: PIXEL })

    expect(status).toBe(200)
    expect(calls[0]!.images).toEqual([PIXEL])
    expect(calls[0]!.prompt).toContain('参考图')
  })

  it('lays the requested timeline over whatever the model wrote on each shot', async () => {
    const restimed = {
      ...PLAN,
      shots: PLAN.shots.map((one) => ({ ...one, startSeconds: 2, seconds: 12 })),
    }
    setChatFetchForTesting(chatFetchReturning(chatCompletion(JSON.stringify(restimed))))

    const { status, json } = await plan({ ...REQUEST, totalSeconds: 10 })

    expect(status).toBe(200)
    const { shots } = (json as { plan: { shots: { startSeconds: number; seconds: number }[] } })
      .plan
    expect(shots.map((one) => [one.startSeconds, one.seconds])).toEqual([
      [0, 5],
      [5, 5],
    ])
  })

  it('retries once when the model answers with something other than a plan', async () => {
    const fetchImpl = chatFetchReturning(
      chatCompletion('抱歉，我无法完成'),
      chatCompletion(`\`\`\`json\n${JSON.stringify(PLAN)}\n\`\`\``),
    )
    setChatFetchForTesting(fetchImpl)

    const { status, json } = await plan(REQUEST)

    expect(status).toBe(200)
    expect(json).toEqual({ plan: TIMED })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('fails with 502 when the retry is still not a plan', async () => {
    const fetchImpl = chatFetchReturning(chatCompletion('not json at all'))
    setChatFetchForTesting(fetchImpl)

    const { status, json } = await plan(REQUEST)

    expect(status).toBe(502)
    expect(json).toEqual({ error: 'storyboard_invalid_response' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('fails with 502 when the model returns the wrong number of shots twice', async () => {
    const fetchImpl = chatFetchReturning(
      chatCompletion(JSON.stringify({ ...PLAN, shots: [shot(1), shot(2), shot(3)] })),
    )
    setChatFetchForTesting(fetchImpl)

    const { status, json } = await plan(REQUEST)

    expect(status).toBe(502)
    expect(json).toEqual({ error: 'storyboard_invalid_response' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('passes an upstream failure through as 502 with the upstream status', async () => {
    setChatFetchForTesting(chatFetchReturning(new Response('rate limited', { status: 429 })))

    const { status, json } = await plan(REQUEST)

    expect(status).toBe(502)
    expect(json).toEqual({ error: 'storyboard_upstream_error', upstream_status: 429 })
  })

  it('rejects a body outside the offered shot counts, totals, ratios and lengths', async () => {
    expect((await plan({ ...REQUEST, idea: '' })).status).toBe(400)
    expect((await plan({ ...REQUEST, idea: 'x'.repeat(2001) })).status).toBe(400)
    expect((await plan({ ...REQUEST, shots: 6 })).status).toBe(400)
    expect((await plan({ ...REQUEST, totalSeconds: 8 })).status).toBe(400)
    expect((await plan({ ...REQUEST, aspectRatio: '4:3' })).status).toBe(400)
    expect((await plan({ ...REQUEST, style: 'x'.repeat(101) })).status).toBe(400)
    expect((await plan({ ...REQUEST, referenceImage: 'https://example.com/a.jpg' })).status).toBe(
      400,
    )

    const missing = await plan({ shots: 2, totalSeconds: 15, aspectRatio: '9:16' })
    expect(missing.status).toBe(400)
    expect(missing.json).toMatchObject({ error: 'invalid_request' })
  })
})
