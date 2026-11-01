import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'

process.env.DATABASE_URL = await resetTestDatabase('bff_internal_operator_config')
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.OPERATOR_CONFIG_FILE = ''
process.env.PORT = '0'

const { close, db, schema } = await import('../../db/client')
const { app } = await import('../../app')

const endpoint = 'http://localhost/internal/admin/operator-config'
const auth = { authorization: 'Bearer fixture-service-credential-alpha' }

async function request(path = '', init: RequestInit = {}) {
  return app.handle(
    new Request(`${endpoint}${path}`, {
      ...init,
      headers: { ...auth, 'content-type': 'application/json', ...(init.headers ?? {}) },
    }),
  )
}

afterAll(close)
beforeEach(async () => {
  await db.delete(schema.operator_config_overrides)
  await db.delete(schema.operator_audits)
})

describe('operator config internal API', () => {
  it('requires internal service authentication', async () => {
    const response = await app.handle(new Request(endpoint))
    expect(response.status).toBe(401)
  })

  it('sets and clears a hot capability with revision and audit', async () => {
    const initial = await request()
    expect(initial.status).toBe(200)
    const before = (await initial.json()) as {
      revision: number
      settings: Array<{ key: string; effective: boolean }>
    }
    const initialRevision = before.revision
    const cli = before.settings.find((entry) => entry.key === 'cli:api')
    expect(cli?.effective).toBe(false)

    const saved = await request('/cli%3Aapi', {
      method: 'PUT',
      body: JSON.stringify({
        value: true,
        reason: 'enable CLI smoke test',
        expectedRevision: initialRevision,
      }),
      headers: { 'x-admin-operator': 'operator-test' },
    })
    expect(saved.status).toBe(200)
    const afterSave = (await saved.json()) as {
      settings: Array<{ key: string; effective: boolean; override: boolean | null }>
    }
    expect(afterSave.settings.find((entry) => entry.key === 'cli:api')).toMatchObject({
      effective: true,
      override: true,
    })

    const stale = await request('/cli%3Aapi', {
      method: 'PUT',
      body: JSON.stringify({ value: false, reason: 'stale', expectedRevision: initialRevision }),
    })
    expect(stale.status).toBe(409)
    expect((await stale.json()).error).toBe('stale_revision')

    const audits = await db.select().from(schema.operator_audits)
    expect(audits[0]?.details).toMatchObject({
      before: false,
      after: true,
      reason: 'enable CLI smoke test',
    })

    const currentRevision =
      (
        await db
          .select({ revision: schema.operator_config_state.revision })
          .from(schema.operator_config_state)
          .limit(1)
      )[0]?.revision ?? 0
    const cleared = await request(
      `/cli%3Aapi?expectedRevision=${currentRevision}&reason=disable%20CLI`,
      {
        method: 'DELETE',
      },
    )
    expect(cleared.status).toBe(200)
    const afterClear = (await cleared.json()) as {
      settings: Array<{ key: string; effective: boolean; override: unknown }>
    }
    expect(afterClear.settings.find((entry) => entry.key === 'cli:api')).toMatchObject({
      effective: false,
      override: null,
    })
  })

  it('rejects boot-time settings and missing reasons', async () => {
    const boot = await request('/agent%3Achat', {
      method: 'PUT',
      body: JSON.stringify({ value: true, reason: 'not allowed', expectedRevision: 0 }),
    })
    expect(boot.status).toBe(409)
    expect((await boot.json()).error).toBe('boot_time_only')

    const missingReason = await request('/cli%3Aapi', {
      method: 'PUT',
      body: JSON.stringify({ value: true, reason: '', expectedRevision: 0 }),
    })
    expect(missingReason.status).toBe(422)
  })
})
