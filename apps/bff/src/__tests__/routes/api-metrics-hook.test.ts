import { afterAll, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'

const bffRoot = resolve(import.meta.dir, '../../..')
process.env.PORT = '0'
process.env.DATABASE_URL = await resetTestDatabase('bff_api_metrics_hook')
process.env.OPERATOR_CONFIG_FILE = resolve(bffRoot, 'operator-config.example.json')
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'

const { app, apiMetrics } = await import('../../app')
const { close, db, schema } = await import('../../db/client')
const { log } = await import('../../lib/logger')
const { closeServerLogDatabase } = await import('../../lib/server-logs')
const { withRequestContext } = await import('../../lib/request-context')
const { captureLogLines } = await import('../helpers/logCapture')
const lines = captureLogLines(log)

afterAll(async () => {
  await closeServerLogDatabase()
  await close()
})

function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.handle(new Request(`http://localhost${path}`, { headers }))
}

describe('API statistics on the real request pipeline', () => {
  it('stores access logs forwarded by the collector, with request correlation and a template route, excluding health and internal requests', async () => {
    const handler = withRequestContext((request) => app.handle(request))
    await handler(
      new Request('http://localhost/api/capabilities', {
        headers: { 'x-request-id': 'access-log-request' },
      }),
    )
    await handler(
      new Request('http://localhost/api/no-such-endpoint', {
        headers: { 'x-request-id': 'rejected-log-request' },
      }),
    )
    await handler(
      new Request('http://localhost/health', {
        headers: { 'x-request-id': 'excluded-health-request' },
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    // What the deployment's Fluent Bit posts: one record per line the BFF container printed.
    const forwarded = lines.splice(0).map((line) => ({
      date: Date.now() / 1000,
      container_name: '/image-playground-paid-r20261007153518-2827408-bff',
      source: 'stdout',
      log: line,
    }))
    const ingest = await app.handle(
      new Request('http://localhost/internal/logs/ingest', {
        method: 'POST',
        headers: {
          authorization: 'Bearer fixture-service-credential-alpha',
          'content-type': 'application/json',
        },
        body: JSON.stringify(forwarded),
      }),
    )
    expect(ingest.status).toBe(204)
    const retry = await app.handle(
      new Request('http://localhost/internal/logs/ingest', {
        method: 'POST',
        headers: {
          authorization: 'Bearer fixture-service-credential-alpha',
          'content-type': 'application/json',
        },
        body: JSON.stringify([...forwarded, null, {}]),
      }),
    )
    expect(retry.status).toBe(204)
    const denied = await app.handle(
      new Request('http://localhost/internal/logs/ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(forwarded),
      }),
    )
    expect(denied.status).toBe(401)
    await new Promise((resolve) => setTimeout(resolve, 20))
    // The ingest call itself is never logged, or every flush would feed the next one.
    expect(lines.some((line) => line.includes('/internal/logs/ingest'))).toBe(false)
    const records = await db
      .select()
      .from(schema.server_logs)
      .where(eq(schema.server_logs.event, 'http.request'))
    expect(records.filter((row) => row.request_id === 'access-log-request')).toHaveLength(1)
    const successful = records.find((row) => row.request_id === 'access-log-request')
    const rejected = records.find((row) => row.request_id === 'rejected-log-request')
    expect(successful).toMatchObject({
      service: 'bff',
      instance: 'image-playground-paid-r20261007153518-2827408-bff',
      level: 'info',
      fields: { status: 200, route: 'GET /api/capabilities' },
    })
    expect(rejected).toMatchObject({ level: 'warn', fields: { status: 404 } })
    expect(records.some((row) => row.request_id === 'excluded-health-request')).toBe(false)
  })

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
