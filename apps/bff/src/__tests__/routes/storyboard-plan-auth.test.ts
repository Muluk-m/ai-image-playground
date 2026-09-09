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
process.env.STORYBOARD_MODEL = 'fixture-storyboard-model'
process.env.OPERATOR_CONFIG_FILE = resolve(
  import.meta.dir,
  '../storyboard-login-operator-config.json',
)

// Dynamic import keeps environment setup ahead of configuration module evaluation.
const { storyboardPlanRoutes } = await import('../../routes/storyboard-plan')
const { setChatFetchForTesting } = await import('../../lib/chatCompletion')

const app = new Elysia().use(storyboardPlanRoutes)

const REQUEST = { idea: '一支讲通勤咖啡的短片', shots: 2, totalSeconds: 10, aspectRatio: '9:16' }

function shot(no: number) {
  return {
    no,
    title: `第 ${no} 镜`,
    description: '主角在清晨的地铁口捧着纸杯',
    camera: '缓慢推进',
    line: '',
    imagePrompt: 'commuter holding a paper cup at a subway entrance, 9:16',
    videoPrompt: 'slow push in, steam rises',
  }
}

const PLAN = {
  title: '通勤第一口',
  summary: '两镜讲清一杯咖啡的早晨',
  videoPrompt:
    '通勤者捧着纸杯，清晨地铁口\n镜头1（0-5秒）：走出地铁口\n镜头2（5-10秒）：纸杯升起热气',
  shots: [shot(1), shot(2)],
}

function plan(headers: Record<string, string> = {}): Promise<Response> {
  return app.handle(
    new Request('http://localhost/api/storyboard/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(REQUEST),
    }),
  )
}

afterEach(() => {
  setChatFetchForTesting()
})

describe('POST /api/storyboard/plan with accounts:login enabled', () => {
  it('answers 401 without a session and burns no model call', async () => {
    const fetchImpl = chatFetchReturning(chatCompletion(JSON.stringify(PLAN)))
    setChatFetchForTesting(fetchImpl)

    const response = await plan()

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'unauthorized' })
    expect(fetchImpl).toHaveBeenCalledTimes(0)
  })

  it('accepts the configured service credential', async () => {
    const fetchImpl = chatFetchReturning(chatCompletion(JSON.stringify(PLAN)))
    setChatFetchForTesting(fetchImpl)

    const response = await plan({ authorization: 'Bearer fixture-service-credential-alpha' })

    expect(response.status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
