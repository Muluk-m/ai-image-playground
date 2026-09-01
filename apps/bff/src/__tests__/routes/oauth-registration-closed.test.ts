import { afterAll, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'

const TEST_DB = await resetTestDatabase('bff_oauth_closed')

process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
process.env.DATABASE_URL = TEST_DB
process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com'
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../login-only-operator-config.json')
process.env.AUTH_PUBLIC_ORIGIN = 'https://api.example.com'
process.env.OAUTH_GOOGLE_CLIENT_ID = 'google-client-fixture'
process.env.OAUTH_GOOGLE_CLIENT_SECRET = 'google-secret-fixture'

const { app } = await import('../../app')
const { close: closeDb, db, schema } = await import('../../db/client')
const { setOAuthFetchForTesting } = await import('../../lib/oauth')

afterAll(async () => {
  setOAuthFetchForTesting()
  await closeDb()
})

function request(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.handle(new Request(`https://api.example.com${path}`, { headers }))
}

describe('oauth callback with self-registration disabled', () => {
  it('refuses to provision a first-time subject', async () => {
    setOAuthFetchForTesting((async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === 'https://oauth2.googleapis.com/token') {
        return Response.json({ access_token: 'google-grant-alpha' })
      }
      return Response.json({ sub: 'new-subject', email: 'new@example.com', email_verified: true })
    }) as typeof fetch)

    const start = await request('/api/auth/oauth/google/start')
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state') ?? ''
    const cookie = start.headers.getSetCookie()[0]?.split(';')[0] ?? ''

    const response = await request(
      `/api/auth/oauth/google/callback?code=code-alpha&state=${encodeURIComponent(state)}`,
      { cookie },
    )
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(
      'https://app.example.com/?auth_error=registration_closed',
    )
    expect(await db.select().from(schema.users)).toHaveLength(0)
    expect(await db.select().from(schema.user_identities)).toHaveLength(0)
  })
})
