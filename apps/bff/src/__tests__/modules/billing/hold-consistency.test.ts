import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { createDb } from '@image-playground/db'
import { creditAccounts, creditLedger, taskHolds } from '@image-playground/db/billing'
import { resetTestDatabase } from '@image-playground/db/testing'
import {
  checkHoldConsistency,
  formatConsistencyReport,
} from '../../../modules/billing/hold-consistency'

const TEST_DB = await resetTestDatabase('billing_hold_consistency')
const { ensureBillingMigrations } = await import('@image-playground/db')
await ensureBillingMigrations(TEST_DB)

const handle = createDb(TEST_DB)
const { db, schema } = handle

const NOW = Date.UTC(2026, 10, 8, 12, 0, 0)
const HOUR = 3_600_000

afterAll(async () => {
  await handle.close()
})

type TaskStatus = 'queued' | 'in_progress' | 'reconciling' | 'completed' | 'failed' | 'cancelled'
type HoldStatus = 'held' | 'committed' | 'released'

async function seedUser(id: string): Promise<void> {
  await db
    .insert(schema.users)
    .values({
      id,
      username: id,
      password_hash: 'fixture-hash',
      status: 'active',
      created_at: NOW,
      updated_at: NOW,
    })
    .onConflictDoNothing()
}

async function seedTask(input: {
  id: string
  status: TaskStatus
  metered?: boolean
  withMetering?: boolean
  /** metering.pricing.exemption, as an analysis task under billing:chat-free records it. */
  exemption?: 'none' | 'chat-free'
  kind?: 'queue' | 'analysis'
  submittedHoursAgo?: number
  hold?: { status: HoldStatus; amount?: number; settledAt?: number | null }
}): Promise<void> {
  await seedUser('user-1')
  const finished = ['completed', 'failed', 'cancelled'].includes(input.status)
  await db.insert(schema.tasks).values({
    id: input.id,
    provider: 'openai-compat',
    model: 'gpt-image-2',
    status: input.status,
    request_payload: { prompt: 'consistency fixture', device_id: 'fixture-device' },
    submitted_at: NOW - (input.submittedHoursAgo ?? 10) * HOUR,
    completed_at: finished ? NOW - 5 * HOUR : null,
    reconciliation_required: input.status === 'reconciling',
    ...(input.kind ? { kind: input.kind } : {}),
    user_id: 'user-1',
    ...(input.withMetering === false
      ? {}
      : {
          metering: {
            mode: input.metered === false ? ('none' as const) : ('credits' as const),
            model: 'gpt-image-2',
            quantity: 1,
            unitMultiplier: 1,
            ...(input.exemption ? { pricing: { exemption: input.exemption } as never } : {}),
          },
        }),
  })
  if (input.hold) {
    const settled = input.hold.status !== 'held'
    await db.insert(taskHolds).values({
      task_id: input.id,
      user_id: 'user-1',
      subscription_amount: 0,
      recharge_amount: input.hold.amount ?? 100,
      total_amount: input.hold.amount ?? 100,
      model: 'gpt-image-2',
      quantity: 1,
      status: input.hold.status,
      created_at: NOW - 10 * HOUR,
      settled_at:
        input.hold.settledAt === undefined
          ? settled
            ? NOW - 5 * HOUR
            : null
          : input.hold.settledAt,
    })
  }
}

beforeEach(async () => {
  await db.delete(creditLedger)
  await db.delete(taskHolds)
  await db.delete(creditAccounts)
  await db.delete(schema.tasks)
  await db.delete(schema.users)
})

describe('task / hold consistency check', () => {
  it('finds nothing wrong when every task and hold moved together', async () => {
    await seedTask({ id: 't-queued', status: 'queued', hold: { status: 'held' } })
    await seedTask({ id: 't-running', status: 'in_progress', hold: { status: 'held' } })
    await seedTask({ id: 't-reconciling', status: 'reconciling', hold: { status: 'held' } })
    await seedTask({ id: 't-done', status: 'completed', hold: { status: 'committed' } })
    await seedTask({ id: 't-failed', status: 'failed', hold: { status: 'released' } })
    await seedTask({ id: 't-cancelled', status: 'cancelled', hold: { status: 'released' } })
    // Tasks that were never metered have no hold, and that is fine.
    await seedTask({ id: 't-free', status: 'completed', metered: false })
    await seedTask({ id: 't-before-billing', status: 'completed', withMetering: false })
    const report = await checkHoldConsistency({ db, now: NOW })
    expect(report.ok).toBe(true)
    expect(report.samples).toEqual([])
    expect(formatConsistencyReport(report)).toContain('OK: no task/hold mismatches')
  })

  it('names each kind of mismatch, with counts and credits', async () => {
    await seedTask({ id: 'stuck', status: 'completed', hold: { status: 'held', amount: 70 } })
    await seedTask({ id: 'stuck-2', status: 'failed', hold: { status: 'held', amount: 30 } })
    await seedTask({
      id: 'free-ride',
      status: 'completed',
      hold: { status: 'released', amount: 50 },
    })
    await seedTask({
      id: 'overcharge',
      status: 'failed',
      hold: { status: 'committed', amount: 40 },
    })
    await seedTask({
      id: 'early',
      status: 'in_progress',
      hold: { status: 'committed', amount: 20 },
    })
    await seedTask({ id: 'incoherent', status: 'queued', hold: { status: 'held', settledAt: NOW } })
    await seedTask({
      id: 'unsettled-at',
      status: 'completed',
      hold: { status: 'committed', settledAt: null },
    })
    await seedTask({ id: 'no-hold', status: 'in_progress' })
    await seedTask({
      id: 'free-but-held',
      status: 'in_progress',
      metered: false,
      hold: { status: 'held', amount: 10 },
    })
    const report = await checkHoldConsistency({ db, now: NOW })
    expect(report.ok).toBe(false)
    expect(report.counts.hold_on_unmetered_task).toEqual({ tasks: 1, credits: 10 })
    expect(report.counts.stuck_hold).toEqual({ tasks: 2, credits: 100 })
    expect(report.counts.delivered_not_charged).toEqual({ tasks: 1, credits: 50 })
    expect(report.counts.charged_without_result).toEqual({ tasks: 1, credits: 40 })
    expect(report.counts.early_settlement).toEqual({ tasks: 1, credits: 20 })
    expect(report.counts.hold_state_incoherent.tasks).toBe(2)
    expect(report.counts.missing_hold).toEqual({ tasks: 1, credits: 0 })
    const byKind = (kind: string) =>
      report.samples.filter((s) => s.kind === kind).map((s) => s.taskId)
    expect(byKind('stuck_hold').sort()).toEqual(['stuck', 'stuck-2'])
    expect(byKind('missing_hold')).toEqual(['no-hold'])
    const text = formatConsistencyReport(report)
    expect(text).toContain('FAIL stuck_hold: 2 tasks, 100 credits')
    expect(text).toContain('FAILED: task/hold mismatches found')
  })

  it('counts everything but lists only the oldest few of a kind', async () => {
    for (const id of ['a', 'b', 'c']) {
      await seedTask({ id, status: 'completed', hold: { status: 'held' } })
    }
    const report = await checkHoldConsistency({ db, now: NOW, sampleLimit: 2 })
    expect(report.counts.stuck_hold.tasks).toBe(3)
    expect(report.samples).toHaveLength(2)
    expect(formatConsistencyReport(report)).toContain('… 1 more')
  })

  it('does not call a deliberately unreserved analysis task a missing hold', async () => {
    // Under billing:chat-free an analysis task records mode "credits" but is never reserved.
    await seedTask({
      id: 'analysis-free',
      status: 'queued',
      kind: 'analysis',
      exemption: 'chat-free',
    })
    const exempt = await checkHoldConsistency({ db, now: NOW })
    expect(exempt.ok).toBe(true)
    expect(exempt.counts.missing_hold.tasks).toBe(0)
    // The same row without that exemption is a real missing hold.
    await seedTask({ id: 'analysis-billed', status: 'queued', kind: 'analysis', exemption: 'none' })
    const billed = await checkHoldConsistency({ db, now: NOW })
    expect(billed.counts.missing_hold.tasks).toBe(1)
    expect(billed.samples.map((s) => s.taskId)).toEqual(['analysis-billed'])
  })

  it('reports a long-running held task as information only', async () => {
    await seedTask({
      id: 'old',
      status: 'in_progress',
      submittedHoursAgo: 30,
      hold: { status: 'held' },
    })
    await seedTask({
      id: 'fresh',
      status: 'in_progress',
      submittedHoursAgo: 1,
      hold: { status: 'held' },
    })
    // A reconciling task is expected to wait; it is alerted on elsewhere.
    await seedTask({
      id: 'waiting',
      status: 'reconciling',
      submittedHoursAgo: 40,
      hold: { status: 'held' },
    })
    const report = await checkHoldConsistency({ db, now: NOW })
    expect(report.ok).toBe(true)
    expect(report.counts.stale_active_hold.tasks).toBe(1)
    expect(report.samples.map((s) => s.taskId)).toEqual(['old'])
    expect(formatConsistencyReport(report)).toContain('INFO stale_active_hold')
    const lenient = await checkHoldConsistency({ db, now: NOW, staleAfterMs: 48 * HOUR })
    expect(lenient.counts.stale_active_hold.tasks).toBe(0)
  })

  it('gives every sample a numeric since, whichever query produced it', async () => {
    await seedTask({ id: 'stuck', status: 'completed', hold: { status: 'held' } })
    await seedTask({ id: 'no-hold', status: 'in_progress' })
    const report = await checkHoldConsistency({ db, now: NOW })
    expect(report.samples).toHaveLength(2)
    for (const sample of report.samples) expect(typeof sample.since).toBe('number')
    expect(
      JSON.parse(JSON.stringify(report)).samples.map((s: { since: number }) => typeof s.since),
    ).toEqual(['number', 'number'])
  })

  it('writes nothing', async () => {
    await seedTask({ id: 'stuck', status: 'completed', hold: { status: 'held' } })
    const before = await db.select().from(taskHolds)
    await checkHoldConsistency({ db, now: NOW })
    expect(await db.select().from(taskHolds)).toEqual(before)
    expect(await db.select().from(creditLedger)).toEqual([])
  })
})
