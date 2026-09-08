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
const { bgswapPlanRoutes } = await import('../../routes/bgswap-plan')
const { setChatFetchForTesting } = await import('../../lib/chatCompletion')

const app = new Elysia().use(bgswapPlanRoutes)

const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const PLAN = {
  category: '独立式浴缸',
  camera: '略高于缸沿的 3/4 侧视，标准镜头',
  sceneType: 'photo',
  productBox: { x: 0.2, y: 0.3, w: 0.5, h: 0.4 },
  inventory: ['独立式浴缸'],
  plan: '暖白微水泥墙面，浅橡木地板，左侧柔和窗光。',
}

function post(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ image: PIXEL }),
    }),
  )
}

afterEach(() => {
  setChatFetchForTesting()
})

describe('the bgswap vision routes with accounts:login enabled', () => {
  for (const path of ['/api/bgswap/plan', '/api/bgswap/scan']) {
    it(`answers 401 on ${path} without a session and burns no vision call`, async () => {
      const fetchImpl = chatFetchReturning(chatCompletion(JSON.stringify(PLAN)))
      setChatFetchForTesting(fetchImpl)

      const response = await post(path)

      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: 'unauthorized' })
      expect(fetchImpl).toHaveBeenCalledTimes(0)
    })

    it(`accepts the configured service credential on ${path}`, async () => {
      const fetchImpl = chatFetchReturning(chatCompletion(JSON.stringify(PLAN)))
      setChatFetchForTesting(fetchImpl)

      const response = await post(path, {
        authorization: 'Bearer fixture-service-credential-alpha',
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ sceneType: 'photo' })
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    })
  }
})
