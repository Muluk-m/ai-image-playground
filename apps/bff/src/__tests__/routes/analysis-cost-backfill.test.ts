import { afterAll, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'

process.env.DATABASE_URL = await resetTestDatabase('analysis_cost_backfill')
process.env.PORT = '0'
process.env.OPERATOR_CONFIG_FILE = ''
const { db, schema, close } = await import('../../db/client')
const { EMPTY_PRIVATE_BFF_OVERLAY, _setPrivateBffOverlayForTesting } = await import(
  '../../lib/private-overlay'
)
const { recoverAnalysisTasks } = await import('../../lib/analysis-tasks')
afterAll(async () => {
  _setPrivateBffOverlayForTesting()
  await close()
})

it('bounds maintenance to one cost page, coalesces overlapping runs and resumes after missing ledger entries', async () => {
  const now = Date.now()
  await db.insert(schema.analysis_tasks).values(
    Array.from({ length: 101 }, (_, index) => ({
      task_id: `analysis-${String(index).padStart(3, '0')}`,
      user_id: 'owner',
      device_id: 'device',
      batch_id: 'batch',
      plan_version: 1,
      item_key: `item-${index}`,
      attempt: 1,
      origin_turn_id: 'origin',
      model: 'model',
      status: 'completed' as const,
      input_snapshot: {
        model: 'model',
        prompt: '',
        inputs: [],
        estimatedInputTokens: 0,
        evidence: [],
      },
      price_snapshot: {
        model: 'model',
        unit: 'kilo_token' as const,
        quantity: 1,
        unitMultiplier: 1,
        baseUnitCredits: 7,
        outputPriceRatio: 1,
        cachedInputPriceRatio: 0,
        inputEstimateTokens: 0,
        outputReserveTokens: 100,
        exemption: 'none' as const,
        pricingVersion: 'v1',
        quotedAt: now,
        validUntil: null,
      },
      reserved_credits: 7,
      created_at: now,
      completed_at: now,
    })),
  )
  const groups: string[][] = []
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  _setPrivateBffOverlayForTesting({
    ...EMPTY_PRIVATE_BFF_OVERLAY,
    present: true,
    taskHooks: {
      ...EMPTY_PRIVATE_BFF_OVERLAY.taskHooks,
      async taskCredits({ taskIds }): Promise<Readonly<Record<string, number>>> {
        groups.push([...taskIds])
        if (groups.length === 1) {
          entered()
          await held
        }
        return taskIds.includes('analysis-100') ? { 'analysis-100': 3 } : {}
      },
    },
  })
  const first = recoverAnalysisTasks()
  await started
  const overlapping = recoverAnalysisTasks()
  release()
  await Promise.all([first, overlapping])
  expect(groups).toHaveLength(1)
  expect(groups[0]).toHaveLength(100)
  await recoverAnalysisTasks()
  expect(
    (
      await db
        .select()
        .from(schema.analysis_tasks)
        .where(eq(schema.analysis_tasks.task_id, 'analysis-100'))
    )[0]?.actual_credits,
  ).toBe(3)
  expect(
    (
      await db
        .select()
        .from(schema.analysis_tasks)
        .where(eq(schema.analysis_tasks.task_id, 'analysis-000'))
    )[0]?.actual_credits,
  ).toBeNull()
  expect(groups.every((ids) => ids.length <= 100)).toBe(true)
  expect(groups.flat()).toHaveLength(101)

  const [original] = await db
    .select()
    .from(schema.analysis_tasks)
    .where(eq(schema.analysis_tasks.task_id, 'analysis-000'))
  expect(original).toBeDefined()
  await db
    .insert(schema.analysis_tasks)
    .values({ ...original!, task_id: 'analysis-101', item_key: 'newer' })
  let failNext = true
  const retries: string[][] = []
  _setPrivateBffOverlayForTesting({
    ...EMPTY_PRIVATE_BFF_OVERLAY,
    present: true,
    taskHooks: {
      ...EMPTY_PRIVATE_BFF_OVERLAY.taskHooks,
      async taskCredits({ taskIds }): Promise<Readonly<Record<string, number>>> {
        retries.push([...taskIds])
        if (failNext) {
          failNext = false
          throw new Error('ledger_temporarily_unavailable')
        }
        return taskIds.includes('analysis-101') ? { 'analysis-101': 4 } : { 'analysis-000': 2 }
      },
    },
  })
  await expect(recoverAnalysisTasks()).rejects.toThrow('ledger_temporarily_unavailable')
  await recoverAnalysisTasks()
  expect(retries[1]).toEqual(['analysis-101'])
  await recoverAnalysisTasks()
  expect(retries[2]?.[0]).toBe('analysis-000')
  const settled = await db
    .select({ id: schema.analysis_tasks.task_id, credits: schema.analysis_tasks.actual_credits })
    .from(schema.analysis_tasks)
  expect(settled.find((row) => row.id === 'analysis-101')?.credits).toBe(4)
  expect(settled.find((row) => row.id === 'analysis-000')?.credits).toBe(2)
})
