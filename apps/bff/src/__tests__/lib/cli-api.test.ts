import { describe, expect, it } from 'bun:test'
import type { AuthUserView } from '@image-playground/shared'
import { Elysia } from 'elysia'

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/test'
process.env.OPERATOR_CONFIG_FILE = ''

const {
  CLI_API_SCHEMA_VERSION,
  cliApiRoutes,
  cliSuccess,
  createCliTokenRateLimiter,
  translateCliError,
} = await import('../../lib/cli-api')

describe('CLI API envelope', () => {
  it('returns a parseable versioned success envelope', () => {
    expect(cliSuccess({ job_id: 'job-1' })).toEqual({
      schema_version: CLI_API_SCHEMA_VERSION,
      ok: true,
      data: { job_id: 'job-1' },
    })
  })

  it('translates internal errors to stable external codes', () => {
    expect(translateCliError({ error: 'job_not_cancellable' })).toEqual({
      code: 'JOB_NOT_CANCELLABLE',
      message: 'The job cannot be canceled in its current state',
      status: 409,
    })
  })
})

describe('CLI API boundary', () => {
  const user = { id: 'user-1' } as AuthUserView
  const resolveConnection = async (token: string) =>
    token === 'secret' ? { user, scopes: [] } : null
  const endpoint = (options: Parameters<typeof cliApiRoutes>[0]) =>
    new Elysia()
      .use(
        cliApiRoutes({
          resolveConnection,
          limiter: createCliTokenRateLimiter({ maxRequests: 0, windowMs: 1 }),
          ...options,
        }),
      )
      .get('/v1/me', ({ cliUser }) => cliSuccess({ ready: true, user: cliUser.id }))

  it('is unavailable when the capability is disabled', async () => {
    const response = await endpoint({ capabilityCheck: () => false }).handle(
      new Request('http://localhost/v1/me', { headers: { authorization: 'Bearer secret' } }),
    )
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      schema_version: 1,
      ok: false,
      error: { code: 'CAPABILITY_UNAVAILABLE', message: 'The CLI API is unavailable' },
    })
  })

  it('requires a bearer token and preserves the JSON envelope', async () => {
    const response = await endpoint({ capabilityCheck: () => true }).handle(
      new Request('http://localhost/v1/me'),
    )
    expect(response.status).toBe(401)
    expect((await response.json()).error.code).toBe('UNAUTHENTICATED')
  })

  it('limits each token and returns Retry-After', async () => {
    const app = endpoint({
      capabilityCheck: () => true,
      limiter: createCliTokenRateLimiter({ maxRequests: 1, windowMs: 10_000 }),
    })
    const request = () =>
      app.handle(
        new Request('http://localhost/v1/me', { headers: { authorization: 'Bearer secret' } }),
      )
    expect((await (await request()).json()).ok).toBe(true)
    const limited = await request()
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('10')
    expect((await limited.json()).error.code).toBe('RATE_LIMITED')
  })

  it('rejects an unknown token before any handler runs', async () => {
    const response = await endpoint({ capabilityCheck: () => true }).handle(
      new Request('http://localhost/v1/me', { headers: { authorization: 'Bearer other' } }),
    )
    expect(response.status).toBe(401)
    expect((await response.json()).error.code).toBe('UNAUTHENTICATED')
  })

  it('enforces the scope a path requires', async () => {
    const app = new Elysia()
      .use(cliApiRoutes({ resolveConnection, capabilityCheck: () => true }))
      .get('/v1/jobs', () => cliSuccess({ jobs: [] }))
    const response = await app.handle(
      new Request('http://localhost/v1/jobs', { headers: { authorization: 'Bearer secret' } }),
    )
    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe('FORBIDDEN')
  })
})

describe('CLI token rate limiter', () => {
  it('isolates tokens and resets after the fixed window', () => {
    const limiter = createCliTokenRateLimiter({ maxRequests: 1, windowMs: 1_000 })
    expect(limiter.check('a', 0)).toEqual({ allowed: true })
    expect(limiter.check('a', 500)).toEqual({ allowed: false, retryAfterSeconds: 1 })
    expect(limiter.check('b', 500)).toEqual({ allowed: true })
    expect(limiter.check('a', 1_000)).toEqual({ allowed: true })
  })
})
