import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import { sql } from 'drizzle-orm'

const SECRET = 'sk-admin-direct-dddd'
const OTHER = 'sk-admin-direct-eeee'
const MASTER_KEY = 'ab'.repeat(32)
process.env.DATABASE_URL = await resetTestDatabase('bff_gpt_direct_admin_keys')
process.env.UPSTREAM_BASE_URL = 'https://sub2api.example.com'
process.env.UPSTREAM_API_KEY = 'sub2api-key'
process.env.GPT_DIRECT_ENABLED = 'true'
process.env.OPENAI_API_KEY = ''
process.env.OPENAI_API_KEYS = 'test-key-primary-aaaa,test-key-secondary-bbbb'
process.env.OPENAI_API_KEY_BUDGETS_USD = '200,500'
process.env.UPSTREAM_SECRETS_MASTER_KEY = MASTER_KEY
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.PORT = '0'
delete process.env.OPENAI_ADMIN_KEY

const { app } = await import('../../app')
const { db, schema } = await import('../../db/client')
const { close } = await import('../../db/client')
const { configuredDirectKeys, fingerprintOf, gptDirectSizeEnabled, resetAdminDirectKeySnapshot } =
  await import('../../lib/upstream/gpt-key-config')
const { refreshGptDirectKeys } = await import('../../lib/upstream/gpt-direct-admin')
const { selectDirectKey } = await import('../../lib/upstream/gpt-keys')

const auth = {
  authorization: 'Bearer fixture-service-credential-alpha',
  'content-type': 'application/json',
}
const envFingerprint = fingerprintOf('test-key-primary-aaaa').fingerprint

function request(path: string, method = 'GET', body?: unknown, withAuth = true) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(withAuth ? { ...auth, 'x-admin-operator': 'ops' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )
}

beforeEach(async () => {
  resetAdminDirectKeySnapshot()
  await db.delete(schema.operator_audits)
  await db.delete(schema.gpt_direct_admin_keys)
  await db.delete(schema.gpt_direct_key_state)
  await db.delete(schema.gpt_direct_usage)
})

afterAll(() => close())

describe('admin direct keys', () => {
  it('fails closed on state read errors without losing admin precedence', async () => {
    const created = await request('/internal/admin/gpt-direct/keys', 'POST', {
      apiKey: SECRET,
      budgetUsd: 40,
    })
    expect(created.status).toBe(200)
    await db.execute(sql`ALTER TABLE gpt_direct_key_state RENAME TO unavailable_key_state_fixture`)
    try {
      resetAdminDirectKeySnapshot()
      await refreshGptDirectKeys()
      expect(configuredDirectKeys().map((key) => key.fingerprint)).toEqual([
        fingerprintOf(SECRET).fingerprint,
      ])
      expect(gptDirectSizeEnabled()).toBe(false)
      expect(await selectDirectKey({ estimateMicroUsd: 1 })).toBeNull()
    } finally {
      await db.execute(sql`ALTER TABLE unavailable_key_state_fixture RENAME TO gpt_direct_key_state`)
    }
    await refreshGptDirectKeys()
    expect(gptDirectSizeEnabled()).toBe(true)
    expect((await selectDirectKey({ estimateMicroUsd: 1 }))?.fingerprint).toBe(
      fingerprintOf(SECRET).fingerprint,
    )
  })

  it('stores, reorders, and drops keys without echoing the secret, and other workers see them after refresh', async () => {
    expect(
      (
        await request(
          '/internal/admin/gpt-direct/keys',
          'POST',
          { apiKey: SECRET, budgetUsd: 40 },
          false,
        )
      ).status,
    ).toBe(401)

    const created = await request('/internal/admin/gpt-direct/keys', 'POST', {
      apiKey: SECRET,
      budgetUsd: 40,
    })
    expect(created.status).toBe(200)
    const createdBody = await created.json()
    const text = JSON.stringify(createdBody)
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain(MASTER_KEY)
    expect(createdBody.source).toBe('admin')
    expect(createdBody.keys).toHaveLength(1)
    expect(createdBody.keys[0].label.endsWith('dddd')).toBe(true)
    expect(createdBody.keys[0].budget_micro_usd).toBe(40_000_000)
    expect(createdBody.keys[0].enabled).toBe(true)
    const id = createdBody.keys[0].id as string

    resetAdminDirectKeySnapshot()
    expect(configuredDirectKeys()[0]?.fingerprint).toBe(envFingerprint)
    await refreshGptDirectKeys()
    expect(configuredDirectKeys().map((key) => key.fingerprint)).toEqual([
      fingerprintOf(SECRET).fingerprint,
    ])
    expect(gptDirectSizeEnabled()).toBe(true)

    const second = await (
      await request('/internal/admin/gpt-direct/keys', 'POST', { apiKey: OTHER, budgetUsd: 80 })
    ).json()
    const ids = second.keys.map((key: { id: string }) => key.id)
    const reordered = await (
      await request('/internal/admin/gpt-direct/keys/order', 'POST', {
        ids: [ids[1], ids[0]],
        revision: second.revision,
      })
    ).json()
    expect(reordered.keys.map((key: { label: string }) => key.label.slice(-4))).toEqual([
      'eeee',
      'dddd',
    ])
    expect(JSON.stringify(reordered)).not.toContain(OTHER)

    const repriced = await (
      await request(`/internal/admin/gpt-direct/keys/${id}`, 'PATCH', { budgetUsd: 90 })
    ).json()
    expect(repriced.keys.find((key: { id: string }) => key.id === id).budget_micro_usd).toBe(
      90_000_000,
    )
    const disabled = await (
      await request(`/internal/admin/gpt-direct/keys/${id}`, 'PATCH', { enabled: false })
    ).json()
    expect(disabled.keys.find((key: { id: string }) => key.id === id).status).toBe('off')
    expect(gptDirectSizeEnabled()).toBe(true)

    const removed = await (await request(`/internal/admin/gpt-direct/keys/${id}`, 'DELETE')).json()
    expect(removed.keys).toHaveLength(1)
    expect(JSON.stringify(removed)).not.toContain(SECRET)

    const audits = await db.select().from(schema.operator_audits)
    const actions = audits.map((row) => row.action).sort()
    expect(actions).toEqual([
      'gpt_direct_key.create',
      'gpt_direct_key.create',
      'gpt_direct_key.delete',
      'gpt_direct_key.reorder',
      'gpt_direct_key.update',
      'gpt_direct_key.update',
    ])
    expect(JSON.stringify(audits)).not.toContain(SECRET)
    expect(JSON.stringify(audits)).not.toContain(OTHER)

    await request(`/internal/admin/gpt-direct/keys/${ids[1]}`, 'DELETE')
    resetAdminDirectKeySnapshot()
    await refreshGptDirectKeys()
    expect(configuredDirectKeys()[0]?.fingerprint).toBe(envFingerprint)
    expect(gptDirectSizeEnabled()).toBe(true)
  })
})
