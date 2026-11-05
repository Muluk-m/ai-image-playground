import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'

const PRIMARY = 'test-key-primary-aaaa'
const SECONDARY = 'test-key-secondary-bbbb'
process.env.DATABASE_URL = await resetTestDatabase('bff_internal_gpt_direct')
process.env.UPSTREAM_BASE_URL = 'https://sub2api.example.com'
process.env.UPSTREAM_API_KEY = 'sub2api-key'
process.env.GPT_DIRECT_ENABLED = 'true'
process.env.OPENAI_API_KEY = ''
process.env.OPENAI_API_KEYS = `${PRIMARY},${SECONDARY}`
process.env.OPENAI_API_KEY_BUDGETS_USD = '200,500'
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.PORT = '0'
delete process.env.OPENAI_ADMIN_KEY

const { app } = await import('../../app')
const { fingerprintOf } = await import('../../lib/upstream/gpt-key-config')
const { markDirectKeyDisabled } = await import('../../lib/upstream/gpt-keys')
const { db, schema } = await import('../../db/client')
const { close } = await import('../../db/client')

const primary = fingerprintOf(PRIMARY)
const auth = { authorization: 'Bearer fixture-service-credential-alpha' }

function request(path: string, method = 'GET', withAuth = true) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: withAuth ? auth : {},
    }),
  )
}

beforeEach(async () => {
  await db.delete(schema.gpt_direct_usage)
  await db.delete(schema.gpt_direct_key_state)
})

afterAll(() => close())

describe('GET /internal/admin/gpt-direct', () => {
  it('requires the service token and lists fingerprints without the keys', async () => {
    expect((await request('/internal/admin/gpt-direct', 'GET', false)).status).toBe(401)
    const response = await request('/internal/admin/gpt-direct?days=7')
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(
      body.keys.map((key: { ordinal: number; status: string }) => [key.ordinal, key.status]),
    ).toEqual([
      [1, 'available'],
      [2, 'available'],
    ])
    expect(body.currency_note).toBe('usage')
    expect(body.official).toBeNull()
    expect(body.daily).toHaveLength(7)
    expect(JSON.stringify(body)).not.toContain(PRIMARY)
    expect(JSON.stringify(body)).not.toContain(SECONDARY)

    await markDirectKeyDisabled(
      { ...primary, ordinal: 1, secret: PRIMARY, budgetUsd: 200 },
      'invalid',
      Object.assign(new Error('Incorrect API key'), { upstreamStatus: 401 }),
    )
    const disabled = await request('/internal/admin/gpt-direct')
    const disabledBody = await disabled.json()
    expect(disabledBody.keys[0].status).toBe('disabled')
    const restored = await request(
      `/internal/admin/gpt-direct/keys/${primary.fingerprint}/restore`,
      'POST',
    )
    expect(restored.status).toBe(200)
    const again = await (await request('/internal/admin/gpt-direct')).json()
    expect(again.keys[0].status).toBe('available')
    expect(again.keys[0].label).toBe(primary.label)
  })
})
