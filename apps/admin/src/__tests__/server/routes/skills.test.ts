import { afterAll, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'

const databaseUrl = await resetTestDatabase('admin_skills_route')
const requestedUrls: string[] = []
const requestedAuthorization: Array<string | null> = []

process.env.ADMIN_PASSWORD = 'test-pass-1234'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.DATABASE_URL = databaseUrl
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.PORT = '0'

// Start the mock before config captures BFF_INTERNAL_URL.
const mockBff = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    requestedUrls.push(`${url.pathname}${url.search}`)
    requestedAuthorization.push(request.headers.get('authorization'))
    return Response.json({
      skills: [
        {
          name: 'poster',
          title: '海报',
          description: '何时用：做海报',
          icon: 'sparkles',
          summary: '排版海报',
        },
      ],
    })
  },
})
process.env.BFF_INTERNAL_URL = `http://127.0.0.1:${mockBff.port}`

// 动态 import：server/config 在模块加载时读 env，静态 import 会在上面那几行写完之前就把配置定死。
const { app } = await import('../../../../server/app')

afterAll(() => {
  mockBff.stop()
})

async function login(): Promise<string> {
  const response = await app.handle(
    new Request('http://localhost/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.181' },
      body: JSON.stringify({ password: 'test-pass-1234' }),
    }),
  )
  return response.headers.get('set-cookie')!.split(';')[0]!
}

describe('GET /api/skills', () => {
  it('requires the Admin session', async () => {
    const response = await app.handle(new Request('http://localhost/api/skills?mode=video'))
    expect(response.status).toBe(401)
    expect(requestedUrls).toEqual([])
  })

  it('forwards the asked mode to the BFF skill catalog through service authentication', async () => {
    const cookie = await login()
    const response = await app.handle(
      new Request('http://localhost/api/skills?mode=video', { headers: { cookie } }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      skills: [
        {
          name: 'poster',
          title: '海报',
          description: '何时用：做海报',
          icon: 'sparkles',
          summary: '排版海报',
        },
      ],
    })
    expect(requestedUrls).toEqual(['/api/agent/skills?mode=video'])
    expect(requestedAuthorization).toEqual(['Bearer fixture-service-credential-alpha'])
  })

  it('omits the query entirely when no mode is asked, letting the BFF default to image', async () => {
    const cookie = await login()
    requestedUrls.length = 0
    const response = await app.handle(
      new Request('http://localhost/api/skills', { headers: { cookie } }),
    )

    expect(response.status).toBe(200)
    expect(requestedUrls).toEqual(['/api/agent/skills'])
  })
})
