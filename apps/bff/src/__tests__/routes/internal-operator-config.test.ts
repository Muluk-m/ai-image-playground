import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { AlertMessage } from '@image-playground/shared'
import { eq, sql } from 'drizzle-orm'
import type { OperatorSettingsResult as Settings } from '../../lib/operator-config-overrides'
import { _setPrivateBffOverlayForTesting, EMPTY_PRIVATE_BFF_OVERLAY } from '../../lib/private-overlay'
import { waitFor } from '../helpers/upstreamStubs'

process.env.DATABASE_URL = await resetTestDatabase('bff_internal_operator_config')
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.OPERATOR_CONFIG_FILE = `${import.meta.dir}/../operator-overrides-config.json`
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
process.env.AGENT_CHAT_MODEL = 'fixture-chat-model'
process.env.PORT = '0'
_setPrivateBffOverlayForTesting(EMPTY_PRIVATE_BFF_OVERLAY)

// Imports intentionally follow environment setup: config and DB are process singletons.
const { close, db, schema } = await import('../../db/client')
const { app } = await import('../../app')
const { config, setEffectiveOperatorConfig } = await import('../../config')
const { loadOperatorConfig } = await import('../../lib/operator-config')
const { refreshOperatorConfig, refreshOperatorConfigIfChanged, setOperatorConfigAlertSenderForTesting } = await import('../../lib/operator-config-overrides')
const { createAgentTurnRateLimiter } = await import('../../lib/agent/turn-rate-limit')
const { TaskScheduler } = await import('../../workers/task-scheduler')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
const fixture = loadOperatorConfig(process.env.OPERATOR_CONFIG_FILE)
const alerts: AlertMessage[] = []
setOperatorConfigAlertSenderForTesting(async (messages) => { alerts.push(...messages) })
const endpoint = 'http://localhost/internal/admin/operator-config'
const auth = { authorization: 'Bearer fixture-service-credential-alpha' }

async function request(path = '', init: RequestInit = {}) {
  return app.handle(new Request(`${endpoint}${path}`, {
    ...init, headers: { ...auth, 'content-type': 'application/json', ...(init.headers ?? {}) },
  }))
}
async function settings(): Promise<Settings> { return (await request()).json() }
async function save(key: string, value: boolean | number, revision?: number) {
  return request(`/${encodeURIComponent(key)}`, { method: 'PUT',
    headers: { 'x-admin-operator': 'operator-test' },
    body: JSON.stringify({ value, reason: 'operator test', expectedRevision: revision ?? (await settings()).revision }),
  })
}
async function clear(key: string, revision: number) {
  return request(`/${encodeURIComponent(key)}?expectedRevision=${revision}&reason=restore%20baseline`, { method: 'DELETE' })
}
async function me() { return app.handle(new Request('http://localhost/v1/me')) }
async function insertOverride(key: string, value: unknown, revision: number, baselineValue: unknown = false) {
  await db.insert(schema.operator_config_overrides).values({ key, value, revision,
    baseline_value: baselineValue, operator_id: 'database-repair', reason: 'fixture', updated_at: Date.now(),
  })
  await db.update(schema.operator_config_state).set({ revision }).where(eq(schema.operator_config_state.id, 1))
}

afterAll(close)
beforeEach(async () => {
  await db.delete(schema.operator_config_overrides)
  await db.delete(schema.operator_audits)
  await db.delete(schema.tasks)
  await db.delete(schema.daily_quota)
  await db.delete(schema.user_sessions)
  await db.delete(schema.users)
  await db.update(schema.operator_config_state).set({ revision: 0 }).where(eq(schema.operator_config_state.id, 1))
  config.operator = fixture
  await refreshOperatorConfig()
  alerts.length = 0
})

describe('operator config internal API', () => {
  it('requires internal service authentication for reading and refreshing', async () => {
    expect((await app.handle(new Request(endpoint))).status).toBe(401)
    expect((await app.handle(new Request(`${endpoint}/refresh`, { method: 'POST' }))).status).toBe(401)
  })

  it('changes the real CLI boundary immediately, rejects stale set/clear, and audits both writes', async () => {
    expect((await me()).status).toBe(404)
    const initial = await settings()
    const saved = await save('cli:api', true, initial.revision)
    expect(saved.status).toBe(200)
    const enabled = await saved.json() as Settings
    expect(enabled.settings.find((entry) => entry.key === 'cli:api')).toMatchObject({ effective: true, override: true })
    const unauthorized = await me()
    expect(unauthorized.status).toBe(401)
    expect(await unauthorized.json()).toMatchObject({ schema_version: 1, ok: false })
    for (const rejected of [await save('cli:api', false, initial.revision), await clear('cli:api', initial.revision)]) {
      expect(rejected.status).toBe(409)
      expect(await rejected.json()).toMatchObject({ error: 'stale_revision', details: { currentRevision: enabled.revision } })
    }
    const cleared = await clear('cli:api', enabled.revision)
    expect(cleared.status).toBe(200)
    expect((await me()).status).toBe(404)
    const final = await cleared.json() as Settings
    expect(final.revision).toBe(enabled.revision + 1)
    expect(await refreshOperatorConfigIfChanged()).toBeNull()
    const audits = await db.select().from(schema.operator_audits)
    expect(audits).toHaveLength(2)
    expect(audits.find((row) => row.action === 'operator_config.set')).toMatchObject({ operator_id: 'operator-test', target_id: 'cli:api', details: { before: false, after: true, reason: 'operator test' } })
    expect(audits.find((row) => row.action === 'operator_config.clear')?.details).toMatchObject({ before: true, after: false, reason: 'restore baseline' })
  })

  it('round-trips boolean and integer overrides and baselines as JSONB scalars on insert and update', async () => {
    for (const { key, values, baseline, jsonType } of [
      { key: 'cli:api', values: [true, false], baseline: false, jsonType: 'boolean' },
      { key: 'generation:daily-images', values: [20, 12], baseline: 5, jsonType: 'number' },
    ]) {
      for (const value of values) {
        const response = await save(key, value)
        expect(response.status).toBe(200)
        const result = await response.json() as Settings
        expect(result.settings.find((entry) => entry.key === key)).toMatchObject({ baseline, override: value, effective: value })
        const [stored] = await db.select({
          value: schema.operator_config_overrides.value,
          baseline: schema.operator_config_overrides.baseline_value,
          valueType: sql<string>`jsonb_typeof(${schema.operator_config_overrides.value})`,
          baselineType: sql<string>`jsonb_typeof(${schema.operator_config_overrides.baseline_value})`,
        }).from(schema.operator_config_overrides).where(eq(schema.operator_config_overrides.key, key))
        expect(stored).toEqual({ value, baseline, valueType: jsonType, baselineType: jsonType })
      }
    }
  })

  it('denies boot-time and read-only writes, invalid ranges and empty reasons', async () => {
    for (const key of ['accounts:login', 'accounts:sync', 'billing:credits', 'agent:chat', 'operator:console']) {
      const response = await save(key, true, 0)
      expect(response.status).toBe(409)
      expect((await response.json()).error).toBe(key === 'operator:console' ? 'read_only' : 'boot_time_only')
      expect((await clear(key, 0)).status).toBe(409)
    }
    const range = await save('agent:analysis-concurrency', 0, 0)
    expect(range.status).toBe(400)
    expect(await range.json()).toMatchObject({ error: 'value_out_of_range', details: { min: 1, max: 64 } })
    const emptyReason = await request('/cli%3Aapi', { method: 'PUT', body: JSON.stringify({ value: true, reason: '', expectedRevision: 0 }) })
    expect(emptyReason.status).toBe(400)
    expect(await emptyReason.json()).toMatchObject({ error: 'invalid_request', message: expect.stringContaining('/reason:') })
    const blankReason = await request('/cli%3Aapi', { method: 'PUT', body: JSON.stringify({ value: true, reason: '   ', expectedRevision: 0 }) })
    expect(blankReason.status).toBe(400)
    expect(await blankReason.json()).toEqual({ error: 'reason_required' })
  })

  it('keeps the prior effective snapshot when a whole-config reload fails', async () => {
    const previous = config.operator
    expect(() => setEffectiveOperatorConfig({ ...fixture, capabilities: { ...fixture.capabilities, 'billing:chat-free': true } })).toThrow('billing:chat-free requires billing:credits')
    expect(config.operator).toBe(previous)
    expect((await me()).status).toBe(404)
  })

  it('rejects CLI enablement without account sync', async () => {
    config.operator = { ...fixture, capabilities: { ...fixture.capabilities, 'accounts:sync': false, 'agent:attachments': false, 'agent:bulk-attachments': false } }
    const response = await save('cli:api', true, 0)
    expect(response.status).toBe(409)
    expect((await response.json()).details.rule).toContain('accounts:sync')
    expect((await me()).status).toBe(404)
  })

  it('rejects risk dependency failures and collateral forced-off changes', async () => {
    for (const [key, value] of [['billing:chat-free', true], ['sync:attachment-lease-seconds', 0], ['agent:attachment-upload-concurrency', 0]] as const) {
      const response = await save(key, value, 0)
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ error: 'dependency_or_derived_rejected', details: { rule: expect.any(String) } })
    }
    expect((await settings()).revision).toBe(0)
    expect(config.operator.capabilities['agent:bulk-attachments']).toBe(true)
  })

  it('validates clear against remaining overrides rather than silently disabling a dependent capability', async () => {
    expect((await save('accounts:self-register', true)).status).toBe(200)
    expect((await save('accounts:email-verification', true)).status).toBe(200)
    const response = await clear('accounts:self-register', (await settings()).revision)
    expect(response.status).toBe(409)
    expect((await response.json()).details.rule).toContain('accounts:email-verification')
    expect(config.operator.capabilities['accounts:self-register']).toBe(true)
  })

  it('uses transaction DB state instead of a stale process snapshot and serializes competing writes', async () => {
    await insertOverride('accounts:self-register', true, 1)
    expect(config.operator.capabilities['accounts:self-register']).toBe(false)
    expect((await save('accounts:email-verification', true, 1)).status).toBe(200)
    const revision = (await settings()).revision
    const responses = await Promise.all([save('generation:daily-images', 12, revision), save('cli:api', true, revision)])
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409])
  })

  it('keeps changed-baseline overrides active and reports actual effective values', async () => {
    expect((await save('generation:daily-images', 20)).status).toBe(200)
    config.operator = { ...fixture, quotas: { ...fixture.quotas, 'generation:daily-images': 10 } }
    const response = await request('/refresh', { method: 'POST' })
    expect(response.status).toBe(200)
    expect((await settings()).settings.find((row) => row.key === 'generation:daily-images')).toMatchObject({ baseline: 10, override: 20, effective: 20, baselineChanged: true, invalid: false })
    expect(config.operator.quotas['generation:daily-images']).toBe(20)
  })

  it('ignores unknown/read-only rows, isolates invalid overrides, and alerts through the operational sender', async () => {
    await insertOverride('future:feature', true, 1)
    await insertOverride('operator:console', true, 2)
    await insertOverride('accounts:login', false, 3, true)
    await insertOverride('generation:daily-images', -1, 4, 5)
    await insertOverride('billing:chat-free', true, 5)
    await insertOverride('cli:api', true, 6)
    await insertOverride('sync:attachment-lease-seconds', 0, 7, 600)
    const refresh = await request('/refresh', { method: 'POST' })
    expect(refresh.status).toBe(200)
    expect(await refresh.json()).toEqual({ revision: 7 })
    expect((await me()).status).toBe(401)
    expect(config.operator.quotas['generation:daily-images']).toBe(5)
    expect(config.operator.capabilities['accounts:login']).toBe(true)
    expect(config.operator.capabilities['operator:console']).toBe(false)
    expect(config.operator.capabilities['agent:attachments']).toBe(true)
    const current = await settings()
    expect(current.settings.find((row) => row.key === 'future:feature')).toMatchObject({ invalid: true, invalidReason: 'unknown_key' })
    expect(current.settings.find((row) => row.key === 'billing:chat-free')).toMatchObject({ invalid: true, effective: false })
    expect(current.settings.find((row) => row.key === 'generation:daily-images')).toMatchObject({ invalid: true, effective: 5 })
    expect(alerts.map((alert) => alert.detail?.key).sort()).toEqual(['accounts:login', 'billing:chat-free', 'generation:daily-images', 'operator:console', 'sync:attachment-lease-seconds'])
    expect(alerts.every((alert) => alert.rule === 'operator-config')).toBe(true)
  })

  it('applies direct DB updates and deletions through the shared revision refresh path', async () => {
    await insertOverride('cli:api', true, 1)
    expect((await me()).status).toBe(404)
    expect(await refreshOperatorConfigIfChanged()).toBe(1)
    expect((await me()).status).toBe(401)
    await db.delete(schema.operator_config_overrides)
    await db.update(schema.operator_config_state).set({ revision: 2 }).where(eq(schema.operator_config_state.id, 1))
    expect(await refreshOperatorConfigIfChanged()).toBe(2)
    expect((await me()).status).toBe(404)
    expect(await refreshOperatorConfigIfChanged()).toBeNull()
  })

  it('updates both existing turn limiter dimensions without recreating the limiter', async () => {
    const limited = createAgentTurnRateLimiter()
    expect((await save('agent:turns-per-device-minute', 1)).status).toBe(200)
    expect(limited('device', 'address')).toBe(false)
    expect(limited('device', 'other-address')).toBe(true)
    expect((await save('agent:turns-per-device-minute', 3)).status).toBe(200)
    expect(limited('device', 'other-address')).toBe(false)
    expect((await save('agent:turns-per-ip-hour', 1)).status).toBe(200)
    expect(limited('fresh-device', 'fresh-address')).toBe(false)
    expect(limited('another-device', 'fresh-address')).toBe(true)
    expect((await save('agent:turns-per-ip-hour', 3)).status).toBe(200)
    expect(limited('another-device', 'fresh-address')).toBe(false)
  })

  it('uses the hot daily image quota for real submissions', async () => {
    const now = Date.now()
    await db.insert(schema.users).values({ id: 'quota-owner', username: 'quota-owner', password_hash: 'fixture', status: 'active', created_at: now, updated_at: now })
    const session = await db.transaction((tx) => createUserSession('quota-owner', tx))
    const submit = () => app.handle(new Request('http://localhost/v1/queue/openai-compat/gpt-image-1/submit', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: `${USER_SESSION_COOKIE}=${session}` },
      body: JSON.stringify({ prompt: 'fixture', n: 1, device_id: 'override-quota-device', client_request_id: crypto.randomUUID() }),
    }))
    expect((await save('generation:daily-images', 1)).status).toBe(200)
    expect((await submit()).status).toBe(200)
    const rejected = await submit()
    expect(rejected.status).toBe(429)
    expect(await rejected.json()).toMatchObject({ error: 'daily_quota_exceeded', quota: 1, used: 1 })
    expect((await save('generation:daily-images', 2)).status).toBe(200)
    expect((await submit()).status).toBe(200)
  })

  it('updates an existing analysis scheduler concurrency on its next poll', async () => {
    const launched: string[] = []
    const { promise: held, resolve: release } = Promise.withResolvers<void>()
    await db.insert(schema.tasks).values([1, 2].map((index) => ({ id: `analysis-${index}`, kind: 'analysis' as const, provider: 'openai-compat' as const, model: 'fixture', status: 'queued' as const, request_payload: { prompt: 'fixture analysis' }, submitted_at: index })))
    const scheduler = new TaskScheduler({ pollIntervalMs: 10, executeAnalysisTask: async (id) => {
      launched.push(id)
      await db.update(schema.tasks).set({ status: 'in_progress' }).where(eq(schema.tasks.id, id))
      await held
    } })
    try {
      scheduler.start()
      await waitFor(() => launched.length === 1)
      expect((await save('agent:analysis-concurrency', 2)).status).toBe(200)
      await waitFor(() => launched.length === 2)
      expect(launched).toEqual(['analysis-1', 'analysis-2'])
    } finally {
      scheduler.stop()
      release()
      await scheduler.waitForIdle(5000)
    }
  })
})
