import { and, eq, isNull, sql } from 'drizzle-orm'
import { Elysia } from 'elysia'
import { db, schema } from '../db/client'
import { bffDrain } from '../lib/drain'
import { requireInternalService } from '../lib/user-auth'

export const internalDrainRoutes = new Elysia({ prefix: '/internal/deployment' })
  .use(requireInternalService)
  .get('/drain', () => bffDrain.status())
  .post('/drain', () => {
    bffDrain.begin()
    return bffDrain.status()
  })

  .post('/legacy-drain', async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`LOCK TABLE tasks IN SHARE ROW EXCLUSIVE MODE`)
      await tx
        .insert(schema.deployment_controls)
        .values({ key: 'legacy_claims_disabled', enabled: true })
        .onConflictDoUpdate({ target: schema.deployment_controls.key, set: { enabled: true } })
    })
    return { ok: true }
  })
  .get('/legacy-drain', async () => {
    const [row] = await db
      .select({ active: sql<number>`count(*)::integer` })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.kind, 'queue'),
          eq(schema.tasks.status, 'in_progress'),
          isNull(schema.tasks.execution_token),
        ),
      )
    const [gate] = await db
      .select()
      .from(schema.deployment_controls)
      .where(eq(schema.deployment_controls.key, 'legacy_claims_disabled'))
    return { active: row?.active ?? 0, safeToStop: gate?.enabled === true && row?.active === 0 }
  })

  .post('/legacy-resume', async () => {
    await db
      .update(schema.deployment_controls)
      .set({ enabled: false })
      .where(eq(schema.deployment_controls.key, 'legacy_claims_disabled'))
    return { ok: true }
  })
