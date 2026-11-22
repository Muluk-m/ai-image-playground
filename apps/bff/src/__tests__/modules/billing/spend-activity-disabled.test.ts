import { afterAll, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'

const TEST_DB = await resetTestDatabase('billing_activity_disabled')
const SERVICE_CREDENTIAL = 'fixture-service-credential-disabled'
const LOGIN_PHRASE = 'fixture-login-phrase-disabled'

process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
process.env.DATABASE_URL = TEST_DB
process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com'
process.env.INTERNAL_API_TOKEN = SERVICE_CREDENTIAL
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, 'operator-config-billing-off.json')

const { _setPrivateBffOverlayForTesting } = await import('../../../lib/private-overlay')
_setPrivateBffOverlayForTesting()
const { app } = await import('../../../app')
const { close: closeDb } = await import('../../../db/client')

async function jsonReq(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: unknown; headers: Headers }> {
  const requestHeaders = { ...headers }
  if (body !== undefined) requestHeaders['content-type'] = 'application/json'
  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: requestHeaders,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
  return { status: response.status, json: await response.json(), headers: response.headers }
}

afterAll(async () => {
  await closeDb()
})

describe('the spend activity route without the billing capability', () => {
  it('answers 404 to a signed in user', async () => {
    const created = await jsonReq(
      'POST',
      '/internal/admin/users',
      { username: 'activity-user', password: LOGIN_PHRASE },
      { authorization: `Bearer ${SERVICE_CREDENTIAL}` },
    )
    expect(created.status).toBe(201)
    const login = await jsonReq('POST', '/api/auth/login', {
      username: 'activity-user',
      password: LOGIN_PHRASE,
    })
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!

    const activity = await jsonReq('GET', '/api/billing/activity', undefined, { cookie })
    expect(activity.status).toBe(404)
    expect(activity.json).toEqual({
      error: 'capability_unavailable',
      capability: 'billing:credits',
    })
  })

  it('answers 404 to the operator view of the whole site', async () => {
    const activity = await jsonReq('GET', '/internal/admin/private/billing/activity', undefined, {
      authorization: `Bearer ${SERVICE_CREDENTIAL}`,
    })
    expect(activity.status).toBe(404)
    expect(activity.json).toEqual({
      error: 'capability_unavailable',
      capability: 'billing:credits',
    })
  })

  it('answers 404 to the operator view of one user', async () => {
    const activity = await jsonReq(
      'GET',
      '/internal/admin/private/billing/users/any-user/activity',
      undefined,
      { authorization: `Bearer ${SERVICE_CREDENTIAL}` },
    )
    expect(activity.status).toBe(404)
    expect(activity.json).toEqual({
      error: 'capability_unavailable',
      capability: 'billing:credits',
    })
  })
})
