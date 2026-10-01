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

it('backfills settled analysis costs after 100 older missing ledger entries without inventing zero charges', async () => {
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
  _setPrivateBffOverlayForTesting({
    ...EMPTY_PRIVATE_BFF_OVERLAY,
    present: true,
    taskHooks: {
      ...EMPTY_PRIVATE_BFF_OVERLAY.taskHooks,
      async taskCredits({ taskIds }): Promise<Readonly<Record<string, number>>> {
        groups.push([...taskIds])
        return taskIds.includes('analysis-100') ? { 'analysis-100': 3 } : {}
      },
    },
  })
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
})
