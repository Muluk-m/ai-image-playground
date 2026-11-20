import { afterAll, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'

const bffRoot = resolve(import.meta.dir, '../../..')
const allowedOrigin = 'https://app.example.com'
process.env.PORT = '0'
process.env.DATABASE_URL = await resetTestDatabase('bff_api_metrics_hook')
process.env.OPERATOR_CONFIG_FILE = resolve(bffRoot, 'operator-config.example.json')
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.CORS_ALLOWED_ORIGINS = allowedOrigin

const { app, apiMetrics } = await import('../../app')
const { close, db, schema } = await import('../../db/client')
const { log } = await import('../../lib/logger')
const { closeServerLogDatabase } = await import('../../lib/server-logs')
const { REQUEST_ID_HEADER, withRequestContext } = await import('../../lib/request-context')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
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
  it('writes access logs with request correlation and a template route, excluding health and internal requests', async () => {
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
    // 容器输出的这些行就是 Collector 收到的日志（ADR 0033 P3，不再经 BFF 入库）。
    const records = lines
      .splice(0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.event === 'http.request')
    const byRequest = (id: string) => records.filter((record) => record.requestId === id)
    expect(byRequest('access-log-request')).toHaveLength(1)
    expect(byRequest('access-log-request')[0]).toMatchObject({
      service: 'bff',
      level: 30,
      status: 200,
      route: 'GET /api/capabilities',
    })
    expect(byRequest('access-log-request')[0]).not.toHaveProperty('path')
    expect(byRequest('rejected-log-request')[0]).toMatchObject({
      level: 40,
      status: 404,
      path: '/api/no-such-endpoint',
    })
    expect(byRequest('excluded-health-request')).toHaveLength(0)
  })

  it('no longer accepts container logs: the BFF does not store them', async () => {
    const ingest = await app.handle(
      new Request('http://localhost/internal/logs/ingest', {
        method: 'POST',
        headers: {
          authorization: 'Bearer fixture-service-credential-alpha',
          'content-type': 'application/json',
        },
        body: '[]',
      }),
    )
    expect(ingest.status).toBe(404)
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

describe('rejected request access logs', () => {
  it('carry the error code and user id of a rejected request, and nothing else from the body', async () => {
    await db.insert(schema.users).values({
      id: 'log-owner',
      username: 'log-owner',
      password_hash: 'unused',
      status: 'active',
      created_at: Date.now(),
      updated_at: Date.now(),
    })
    const token = await db.transaction((tx) => createUserSession('log-owner', tx))
    const submit = (path: string, body: Record<string, unknown>) =>
      app.handle(
        new Request(`http://localhost/v1/queue/${path}/submit`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie: `${USER_SESSION_COOKIE}=${token}`,
          },
          body: JSON.stringify({ device_id: 'log-device', ...body }),
        }),
      )
    lines.splice(0)
    // 依次：路由 onError 改写的校验失败、抛出的阶段授权拒绝、status() 返回的普通拒绝、
    // 错误码里拼了请求内容的拒绝（不记）、没登录的 404。
    expect((await submit('openai-compat/gpt-image-2', { prompt: '' })).status).toBe(400)
    const stage = await submit('openai-compat/gpt-image-2', {
      prompt: '秘密提示词',
      stage_authorization: {
        authorizationId: 'no-such-authorization',
        nodeId: 'a',
        attemptId: 'attempt',
        executionToken: 'secret-execution-token',
      },
    })
    expect(stage.status).toBe(404)
    expect(
      (
        await submit('openai-compat/gpt-image-2', {
          prompt: '秘密提示词',
          video: { duration_seconds: 5, aspect_ratio: '16:9', resolution: '720p' },
        })
      ).status,
    ).toBe(400)
    expect((await submit('no-such-provider/m', { prompt: '秘密提示词' })).status).toBe(400)
    await get('/api/no-such-endpoint')
    await new Promise((resolve) => setTimeout(resolve, 20))
    const logged = lines
      .splice(0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.event === 'http.request')
    expect(logged.map(({ status, error, userId }) => ({ status, error, userId }))).toEqual([
      { status: 400, error: 'invalid_request', userId: 'log-owner' },
      { status: 404, error: 'stage_authorization_not_found', userId: 'log-owner' },
      { status: 400, error: 'video_not_supported', userId: 'log-owner' },
      { status: 400, error: undefined, userId: 'log-owner' },
      { status: 404, error: undefined, userId: undefined },
    ])
    const text = JSON.stringify(logged)
    for (const secret of ['秘密提示词', 'secret-execution-token', 'no-such-provider', '不支持'])
      expect(text).not.toContain(secret)
  })
})

describe('credentialed CORS on the real request pipeline', () => {
  const handle = withRequestContext((request) => app.handle(request))

  it('exposes the response request id to an allowed origin on success and error responses', async () => {
    for (const { path, status } of [
      { path: '/api/capabilities', status: 200 },
      { path: '/api/no-such-endpoint', status: 404 },
      { path: '/internal/admin/capabilities', status: 401 },
    ]) {
      const response = await handle(
        new Request(`http://localhost${path}`, {
          credentials: 'include',
          headers: { origin: allowedOrigin },
        }),
      )

      expect(response.status).toBe(status)
      expect(response.headers.get(REQUEST_ID_HEADER)).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      )
      expect(response.headers.get('access-control-allow-origin')).toBe(allowedOrigin)
      expect(response.headers.get('access-control-allow-credentials')).toBe('true')
      expect(
        response.headers
          .get('access-control-expose-headers')
          ?.toLowerCase()
          .split(/\s*,\s*/),
      ).toContain(REQUEST_ID_HEADER)
    }
  })

  it('keeps credentialed preflight support for the request id header', async () => {
    const response = await handle(
      new Request('http://localhost/api/capabilities', {
        method: 'OPTIONS',
        headers: {
          origin: allowedOrigin,
          'access-control-request-method': 'GET',
          'access-control-request-headers': REQUEST_ID_HEADER,
          [REQUEST_ID_HEADER]: 'cors-preflight-request',
        },
      }),
    )

    expect(response.status).toBe(204)
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe('cors-preflight-request')
    expect(response.headers.get('access-control-allow-origin')).toBe(allowedOrigin)
    expect(response.headers.get('access-control-allow-credentials')).toBe('true')
    expect(response.headers.get('access-control-allow-methods')?.split(/\s*,\s*/)).toContain('GET')
    expect(
      response.headers
        .get('access-control-allow-headers')
        ?.toLowerCase()
        .split(/\s*,\s*/),
    ).toContain(REQUEST_ID_HEADER)
  })

  it('does not authorize other origins for either the response or preflight', async () => {
    for (const method of ['GET', 'OPTIONS']) {
      const response = await handle(
        new Request('http://localhost/api/capabilities', {
          method,
          credentials: 'include',
          headers: {
            origin: 'https://untrusted.example.com',
            [REQUEST_ID_HEADER]: 'cors-rejected-request',
            ...(method === 'OPTIONS'
              ? {
                  'access-control-request-method': 'GET',
                  'access-control-request-headers': REQUEST_ID_HEADER,
                }
              : {}),
          },
        }),
      )

      expect(response.headers.get('access-control-allow-origin')).toBeNull()
    }
  })
})
