import { describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { CAPABILITIES } from '@image-playground/shared'
import { Elysia } from 'elysia'

const bffRoot = resolve(import.meta.dir, '../../..')
process.env.PORT = '0'
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? ''
process.env.OPERATOR_CONFIG_FILE = resolve(bffRoot, 'operator-config.example.json')
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'

const { app } = await import('../../app')
const { capabilityUnavailable } = await import('../../lib/capabilities')

describe('GET /api/capabilities', () => {
  it('is public and returns only explicitly client-exposed capabilities', async () => {
    const response = await app.handle(new Request('http://localhost/api/capabilities'))
    const body = (await response.json()) as Record<string, boolean>
    const exposedKeys = Object.entries(CAPABILITIES)
      .filter(([, definition]) => definition.clientExposed)
      .map(([key]) => key)
      .sort()

    expect(response.status).toBe(200)
    expect(Object.keys(body).sort()).toEqual(exposedKeys)
    expect(body['accounts:login']).toBe(true)
    expect(body).not.toHaveProperty('operator:console')
  })

  it('keeps the operator capability behind service authentication', async () => {
    const unauthenticated = await app.handle(
      new Request('http://localhost/internal/admin/capabilities'),
    )
    expect(unauthenticated.status).toBe(401)

    const response = await app.handle(
      new Request('http://localhost/internal/admin/capabilities', {
        headers: { authorization: 'Bearer fixture-service-credential-alpha' },
      }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ operator_console: false })
  })

  it('standardizes unavailable capability responses', async () => {
    const helperApp = new Elysia().get('/missing', () => capabilityUnavailable('billing:credits'))
    const response = await helperApp.handle(new Request('http://localhost/missing'))

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: 'capability_unavailable',
      capability: 'billing:credits',
    })
  })
})
