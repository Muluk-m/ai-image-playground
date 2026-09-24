import type { QueueProvider } from '@image-playground/shared'
import { and, asc, eq, gt, inArray, isNull, lte, notInArray, or, sql } from 'drizzle-orm'
import { db, schema } from '../db/client'
import { accountGenerationLimits } from './task-execution'

/**
 * Read the oldest tasks that can actually claim an account slot. A cursor and the partial
 * provider/time index keep a single account's large backlog from forcing a full queue sort.
 * The claim transaction still enforces the limit; this read only chooses fair candidates.
 */
export async function selectRunnableTasks(
  provider: QueueProvider,
  available: number,
  now: number,
  options: { excludeArchived?: boolean; orderByEligible?: boolean } = {},
): Promise<Array<{ id: string; eligibleSince: number }>> {
  const selected: Array<{ id: string; eligibleSince: number }> = []
  const excludedUsers = new Set<string>()
  const roundUsers = new Set<string>()
  const selectedTaskIds = new Set<string>()
  const plannedTotal = new Map<string, number>()
  const plannedProvider = new Map<string, number>()
  let roundSelections = 0
  let cursor: { sortAt: number; id: string } | undefined
  const eligibleAt = sql`greatest(${schema.tasks.submitted_at}, coalesce(${schema.tasks.next_retry_at}, ${schema.tasks.submitted_at}))`
  const orderAt = options.orderByEligible ? eligibleAt : schema.tasks.submitted_at
  while (selected.length < available) {
    const afterCursor = cursor
      ? options.orderByEligible
        ? or(
            gt(eligibleAt, sql`to_timestamp(${cursor.sortAt} / 1000.0)`),
            and(
              eq(eligibleAt, sql`to_timestamp(${cursor.sortAt} / 1000.0)`),
              gt(schema.tasks.id, cursor.id),
            ),
          )
        : or(
            gt(schema.tasks.submitted_at, cursor.sortAt),
            and(eq(schema.tasks.submitted_at, cursor.sortAt), gt(schema.tasks.id, cursor.id)),
          )
      : undefined
    const due = await db
      .select({
        id: schema.tasks.id,
        userId: schema.tasks.user_id,
        submittedAt: schema.tasks.submitted_at,
        nextRetryAt: schema.tasks.next_retry_at,
      })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.provider, provider),
          eq(schema.tasks.status, 'queued'),
          eq(schema.tasks.kind, 'queue'),
          options.excludeArchived ? isNull(schema.tasks.archive_payload) : undefined,
          or(isNull(schema.tasks.next_retry_at), lte(schema.tasks.next_retry_at, now)),
          excludedUsers.size || roundUsers.size
            ? or(
                isNull(schema.tasks.user_id),
                notInArray(schema.tasks.user_id, [...excludedUsers, ...roundUsers]),
              )
            : undefined,
          selectedTaskIds.size ? notInArray(schema.tasks.id, [...selectedTaskIds]) : undefined,
          afterCursor,
        ),
      )
      .orderBy(asc(orderAt), asc(schema.tasks.id))
      .limit(Math.max(16, available * 4))
    if (due.length === 0) {
      // Give each account one task before returning to accounts with spare entitlement.
      if (roundSelections === 0 || selected.length >= available) break
      roundUsers.clear()
      roundSelections = 0
      cursor = undefined
      continue
    }
    const last = due[due.length - 1]!
    cursor = {
      sortAt: options.orderByEligible
        ? Math.max(last.submittedAt, last.nextRetryAt ?? last.submittedAt)
        : last.submittedAt,
      id: last.id,
    }

    await db.transaction(async (tx) => {
      const userIds = [...new Set(due.flatMap((task) => (task.userId ? [task.userId] : [])))]
      const activeRows = userIds.length
        ? await tx
            .select({
              userId: schema.tasks.user_id,
              provider: schema.tasks.provider,
              count: sql<number>`count(*)::int`,
            })
            .from(schema.tasks)
            .where(
              and(
                inArray(schema.tasks.user_id, userIds),
                eq(schema.tasks.kind, 'queue'),
                eq(schema.tasks.status, 'in_progress'),
              ),
            )
            .groupBy(schema.tasks.user_id, schema.tasks.provider)
        : []
      const activeTotal = new Map<string, number>()
      const activeProvider = new Map<string, number>()
      for (const row of activeRows) {
        if (!row.userId) continue
        activeTotal.set(row.userId, (activeTotal.get(row.userId) ?? 0) + Number(row.count))
        if (row.provider === provider) activeProvider.set(row.userId, Number(row.count))
      }
      const limits = new Map<string, { total: number; provider: number }>()
      for (const task of due) {
        if (task.userId) {
          if (roundUsers.has(task.userId) || excludedUsers.has(task.userId)) continue
          let limit = limits.get(task.userId)
          if (!limit) {
            limit = await accountGenerationLimits(tx, task.userId, provider, now)
            limits.set(task.userId, limit)
          }
          const total = (activeTotal.get(task.userId) ?? 0) + (plannedTotal.get(task.userId) ?? 0)
          const onProvider =
            (activeProvider.get(task.userId) ?? 0) + (plannedProvider.get(task.userId) ?? 0)
          if (total >= limit.total || onProvider >= limit.provider) {
            excludedUsers.add(task.userId)
            continue
          }
          plannedTotal.set(task.userId, (plannedTotal.get(task.userId) ?? 0) + 1)
          plannedProvider.set(task.userId, (plannedProvider.get(task.userId) ?? 0) + 1)
          roundUsers.add(task.userId)
          if (total + 1 >= limit.total || onProvider + 1 >= limit.provider) {
            excludedUsers.add(task.userId)
          }
        }
        selectedTaskIds.add(task.id)
        roundSelections++
        selected.push({
          id: task.id,
          eligibleSince: Math.max(task.submittedAt, task.nextRetryAt ?? task.submittedAt),
        })
        if (selected.length >= available) break
      }
    })
  }
  return selected
}
