import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { resolve } from 'node:path'
import {
  creditAccounts,
  creditLedger,
  modelPrices,
  subscriptions,
  taskHolds,
} from '@image-playground/db/billing'
import { resetTestDatabase } from '@image-playground/db/testing'
import { and, eq } from 'drizzle-orm'
import { backfillRefundFailedTasks } from '../../../modules/billing/backfill-refund-failed'
import { InMemoryObjectStore } from '../../helpers/inMemoryObjectStore'

const TEST_DB = await resetTestDatabase('billing_spend_activity')
const SERVICE_CREDENTIAL = 'fixture-service-credential-activity'
const LOGIN_PHRASE = 'fixture-login-phrase-activity'
const TIMEZONE = 'Asia/Shanghai'
const PRICE_PER_IMAGE = 100

process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
process.env.DATABASE_URL = TEST_DB
process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com'
process.env.INTERNAL_API_TOKEN = SERVICE_CREDENTIAL
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, 'operator-config.json')
process.env.DEPLOYMENT_TIMEZONE = TIMEZONE
const { ensureBillingMigrations } = await import('@image-playground/db')
await ensureBillingMigrations(TEST_DB)

const { _setPrivateBffOverlayForTesting } = await import('../../../lib/private-overlay')
_setPrivateBffOverlayForTesting()
const { app } = await import('../../../app')
const { close: closeDb, db, schema } = await import('../../../db/client')
const { setObjectStoreForTesting } = await import('../../../lib/objectStore')
const { setUpstreamFetchForTesting } = await import('../../../lib/upstream')
const { _setChannelsForTesting } = await import('../../../lib/channels')
const { runTask } = await import('../../../workers/task-runner')
type TestFetch = NonNullable<Parameters<typeof setUpstreamFetchForTesting>[0]>

interface ActivityJson {
  request_id?: string
  error?: string
  from?: string
  to?: string
  timezone?: string
  days?: Array<{ date: string; count: number }>
}

const DAY_MS = 86_400_000

function today(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(Date.now())
}

function shiftDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

async function jsonReq(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: ActivityJson; headers: Headers }> {
  const requestHeaders = { ...headers }
  if (body !== undefined) requestHeaders['content-type'] = 'application/json'
  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: requestHeaders,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
  const json = (await response.json()) as ActivityJson
  return { status: response.status, json, headers: response.headers }
}

async function resetDb(): Promise<void> {
  await db.delete(creditLedger)
  await db.delete(taskHolds)
  await db.delete(subscriptions)
  await db.delete(creditAccounts)
  await db.delete(schema.tasks)
  await db.delete(schema.daily_quota)
  await db.delete(schema.user_sessions)
  await db.delete(schema.operator_audits)
  await db.delete(schema.users)
  await db
    .update(modelPrices)
    .set({ credits_per_image: PRICE_PER_IMAGE, active: true, updated_at: Date.now() })
    .where(eq(modelPrices.model, 'gpt-image-2'))
}

async function createAndLogin(username: string): Promise<string> {
  const created = await jsonReq(
    'POST',
    '/internal/admin/users',
    { username, password: LOGIN_PHRASE },
    { authorization: `Bearer ${SERVICE_CREDENTIAL}` },
  )
  expect(created.status).toBe(201)
  const login = await jsonReq('POST', '/api/auth/login', { username, password: LOGIN_PHRASE })
  expect(login.status).toBe(200)
  return login.headers.get('set-cookie')!.split(';')[0]!
}

function stubUpstream(response: () => Response): void {
  setUpstreamFetchForTesting(mock(async () => response()) as unknown as TestFetch)
}

function deliveredImage(): Response {
  return new Response(JSON.stringify({ data: [{ b64_json: 'SU1BR0U=' }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function upstreamRefusal(): Response {
  return new Response(JSON.stringify({ error: { message: 'content policy violation' } }), {
    status: 403,
    headers: { 'content-type': 'application/json' },
  })
}

async function runOneTask(cookie: string, quantity = 1): Promise<string> {
  const submitted = await jsonReq(
    'POST',
    '/v1/queue/openai-compat/gpt-image-2/submit',
    {
      prompt: 'a lighthouse in rain',
      n: quantity,
      device_id: 'activity-device-aaaa-bbbb',
      client_request_id: crypto.randomUUID(),
    },
    { cookie },
  )
  expect(submitted.status).toBe(200)
  const taskId = submitted.json.request_id
  if (!taskId) throw new Error('submission did not return a request_id')
  await runTask(taskId)
  return taskId
}

async function activity(
  cookie: string,
  query = '',
): Promise<{ status: number; json: ActivityJson }> {
  return jsonReq('GET', `/api/billing/activity${query}`, undefined, { cookie })
}

async function userIdOf(username: string): Promise<string> {
  const [row] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.username, username))
    .limit(1)
  if (!row) throw new Error(`no user named ${username}`)
  return row.id
}

async function internalActivity(
  userId: string,
  headers: Record<string, string> = { authorization: `Bearer ${SERVICE_CREDENTIAL}` },
): Promise<{ status: number; json: ActivityJson }> {
  return jsonReq(
    'GET',
    `/internal/admin/private/billing/users/${encodeURIComponent(userId)}/activity`,
    undefined,
    headers,
  )
}

async function siteActivity(
  headers: Record<string, string> = { authorization: `Bearer ${SERVICE_CREDENTIAL}` },
): Promise<{ status: number; json: ActivityJson }> {
  return jsonReq('GET', '/internal/admin/private/billing/activity', undefined, headers)
}

function days(result: { json: ActivityJson }): Array<{ date: string; count: number }> {
  if (!result.json.days) throw new Error('response did not contain activity days')
  return result.json.days
}

function total(result: { json: ActivityJson }): number {
  return days(result).reduce((sum, day) => sum + day.count, 0)
}

let storage: InMemoryObjectStore

beforeEach(async () => {
  storage = new InMemoryObjectStore()
  setObjectStoreForTesting(storage)
  await resetDb()
})

afterEach(() => {
  setObjectStoreForTesting()
  setUpstreamFetchForTesting()
  _setChannelsForTesting([])
  mock.restore()
})

afterAll(async () => {
  await closeDb()
})

describe('daily credit spend activity', () => {
  it('records a delivered task on its settlement day', async () => {
    const cookie = await createAndLogin('activity-user')
    stubUpstream(deliveredImage)
    await runOneTask(cookie, 2)

    const result = await activity(cookie)
    expect(result.status).toBe(200)
    expect(result.json.timezone).toBe(TIMEZONE)
    expect(result.json.to).toBe(today())
    expect(result.json.from).toBe(shiftDays(today(), -365))
    expect(days(result)).toEqual([{ date: today(), count: 2 * PRICE_PER_IMAGE }])
  })

  it('leaves out a task that failed and was refunded', async () => {
    const cookie = await createAndLogin('activity-user')
    stubUpstream(upstreamRefusal)
    await runOneTask(cookie)

    expect(days(await activity(cookie))).toEqual([])
  })

  it('sums the tasks delivered on the same day', async () => {
    const cookie = await createAndLogin('activity-user')
    stubUpstream(deliveredImage)
    await runOneTask(cookie)
    await runOneTask(cookie, 2)

    expect(days(await activity(cookie))).toEqual([{ date: today(), count: 3 * PRICE_PER_IMAGE }])
  })

  it('counts only the requesting user', async () => {
    const cookie = await createAndLogin('activity-user')
    const otherCookie = await createAndLogin('other-activity-user')
    stubUpstream(deliveredImage)
    await runOneTask(cookie)
    await runOneTask(otherCookie, 2)

    expect(days(await activity(cookie))).toEqual([{ date: today(), count: PRICE_PER_IMAGE }])
    expect(days(await activity(otherCookie))).toEqual([
      { date: today(), count: 2 * PRICE_PER_IMAGE },
    ])
  })

  it('cuts the day in the deployment timezone rather than in UTC', async () => {
    const cookie = await createAndLogin('activity-user')
    stubUpstream(deliveredImage)
    const taskId = await runOneTask(cookie)

    const localDay = shiftDays(today(), -5)
    const settledAt = Date.parse(`${localDay}T00:30:00+08:00`)
    expect(new Date(settledAt).toISOString().slice(0, 10)).toBe(shiftDays(localDay, -1))
    await db
      .update(creditLedger)
      .set({ created_at: settledAt })
      .where(and(eq(creditLedger.task_id, taskId), eq(creditLedger.entry_type, 'commit')))

    expect(days(await activity(cookie))).toEqual([{ date: localDay, count: PRICE_PER_IMAGE }])
  })

  it('leaves out a task the refund backfill paid back after it was committed', async () => {
    const cookie = await createAndLogin('activity-user')
    stubUpstream(deliveredImage)
    const taskId = await runOneTask(cookie)
    expect(days(await activity(cookie))).toEqual([{ date: today(), count: PRICE_PER_IMAGE }])

    await db.update(schema.tasks).set({ status: 'failed' }).where(eq(schema.tasks.id, taskId))
    const report = await backfillRefundFailedTasks({ db })
    expect(report.refundedTasks).toBe(1)

    expect(days(await activity(cookie))).toEqual([])
  })

  it('accepts a 366 day window and rejects a wider one', async () => {
    const cookie = await createAndLogin('activity-user')

    const widest = await activity(cookie, `?from=${shiftDays(today(), -365)}&to=${today()}`)
    expect(widest.status).toBe(200)

    const tooWide = await activity(cookie, `?from=${shiftDays(today(), -366)}&to=${today()}`)
    expect(tooWide.status).toBe(400)
    expect(tooWide.json.error).toBe('invalid_range')

    const inverted = await activity(cookie, `?from=${today()}&to=${shiftDays(today(), -1)}`)
    expect(inverted.status).toBe(400)
  })

  it('refuses an anonymous request', async () => {
    const anonymous = await jsonReq('GET', '/api/billing/activity')
    expect(anonymous.status).toBe(401)
    expect(anonymous.json.error).toBe('unauthorized')
  })
})

describe("the operator view of one user's spend activity", () => {
  it('answers with the same days the user sees', async () => {
    const cookie = await createAndLogin('activity-user')
    const otherCookie = await createAndLogin('other-activity-user')
    stubUpstream(deliveredImage)
    await runOneTask(cookie, 2)
    await runOneTask(otherCookie)

    const operatorView = await internalActivity(await userIdOf('activity-user'))
    expect(operatorView.status).toBe(200)
    expect(operatorView.json).toEqual((await activity(cookie)).json)
    expect(days(operatorView)).toEqual([{ date: today(), count: 2 * PRICE_PER_IMAGE }])
  })

  it('refuses a request without the internal token', async () => {
    const cookie = await createAndLogin('activity-user')
    const anonymous = await internalActivity(await userIdOf('activity-user'), {})
    expect(anonymous.status).toBe(401)
    expect(anonymous.json.error).toBe('unauthorized')
    expect((await internalActivity(await userIdOf('activity-user'), { cookie })).status).toBe(401)
  })
})

describe('the operator view of site-wide spend activity', () => {
  it('sums every user on the same day', async () => {
    const cookie = await createAndLogin('activity-user')
    const otherCookie = await createAndLogin('other-activity-user')
    stubUpstream(deliveredImage)
    await runOneTask(cookie, 2)
    await runOneTask(otherCookie)

    const siteWide = await siteActivity()
    expect(siteWide.status).toBe(200)
    expect(siteWide.json.timezone).toBe(TIMEZONE)
    expect(days(siteWide)).toEqual([{ date: today(), count: 3 * PRICE_PER_IMAGE }])
    expect(total(siteWide)).toBe(total(await activity(cookie)) + total(await activity(otherCookie)))
  })

  it('leaves out a task that failed and was refunded', async () => {
    const cookie = await createAndLogin('activity-user')
    stubUpstream(upstreamRefusal)
    await runOneTask(cookie)

    expect(days(await siteActivity())).toEqual([])
  })

  it('rejects a window wider than a year', async () => {
    const tooWide = await jsonReq(
      'GET',
      `/internal/admin/private/billing/activity?from=${shiftDays(today(), -366)}&to=${today()}`,
      undefined,
      { authorization: `Bearer ${SERVICE_CREDENTIAL}` },
    )
    expect(tooWide.status).toBe(400)
    expect(tooWide.json.error).toBe('invalid_range')
  })

  it('refuses a request without the internal token', async () => {
    const cookie = await createAndLogin('activity-user')
    expect((await siteActivity({})).status).toBe(401)
    expect((await siteActivity({ cookie })).status).toBe(401)
  })
})
