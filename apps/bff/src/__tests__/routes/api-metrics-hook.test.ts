import { afterAll, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'

const bffRoot = resolve(import.meta.dir, '../../..')
process.env.PORT = '0'
process.env.DATABASE_URL = await resetTestDatabase('bff_api_metrics_hook')
process.env.OPERATOR_CONFIG_FILE = resolve(bffRoot, 'operator-config.example.json')
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'

const { app, apiMetrics } = await import('../../app')
const { close } = await import('../../db/client')

afterAll(async () => {
  await close()
})

function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.handle(new Request(`http://localhost${path}`, { headers }))
}

describe('API statistics on the real request pipeline', () => {
  it('counts user-facing API calls by route template and status, and nothing else', async () => {
    apiMetrics.drain(Date.now(), true)

    expect((await get('/api/capabilities')).status).toBe(200)
    expect((await get('/api/no-such-endpoint')).status).toBe(404)
    await get('/health')
    await get('/internal/admin/ops/backups', {
      authorization: 'Bearer fixture-service-credential-alpha',
    })

    // afterResponse 在响应交出去之后才跑。
    await new Promise((resolve) => setTimeout(resolve, 20))
    const rows = apiMetrics.drain(Date.now(), true)
    const requests = rows.reduce((sum, row) => sum + row.requests, 0)
    const clientErrors = rows.reduce((sum, row) => sum + row.client_errors, 0)
    expect(requests).toBe(2)
    expect(clientErrors).toBe(1)
  })
})
