import type { QueueProvider } from '@image-playground/shared'
import { and, eq, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm'
import { config } from '../config'
import { schema } from '../db/client'
import type { BffTransaction } from '../lib/private-overlay'
import { taskConcurrencyScope } from '../lib/upstream'

/**
 * 空闲时可用并发（弹性名额）。
 *
 * 套餐的「保证并发」（入门 1 / 标准 2 / 专业 3）永远放行；套餐另配的「空闲时可用并发」只在下面
 * 三条同时成立时才多放一个：
 *
 * 1. 全局有余量：这个 provider 正在跑的任务数（库里所有 worker 的 in_progress）+ 1 不超过
 *    worker 并发上限（WORKER_OPENAI_CONCURRENCY / WORKER_GEMINI_CONCURRENCY）。
 * 2. 模型通道有余量：同一个同时在途上限（channels.json 的 `models[].maxConcurrency` 或渠道级
 *    `maxConcurrency`，例如 Vertex 每个模型 2）下正在跑的任务数 + 1 不超过上限。
 * 3. 没有别人在排队：这个 provider 上没有其他账号（含匿名任务）已到点、还在 queued 的任务。
 *    别人的任务——不管是标准/专业用户还是别人的第 1 个任务——一律先跑，弹性名额不挤占任何人。
 *
 * 防超发：判定和认领在同一个事务里，弹性认领先拿按 provider 的事务级 advisory 锁，
 * 多个 worker（发版交接时新旧两个）同时放弹性名额只能排队一个个来，后一个一定看得见前一个
 * 已提交的认领。保证并发的认领不拿这把锁，热路径不变。
 *
 * 已经在跑的弹性任务不中断；余量没了只是不再放新的。
 */

/** 弹性认领在同一 provider 上串行；按 provider 分键，两类 provider 互不阻塞。 */
export async function lockIdleSlotClaims(tx: BffTransaction, provider: QueueProvider) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`idle-concurrency:${provider}`}))`)
}

export function providerConcurrencyLimit(provider: QueueProvider): number {
  return provider === 'openai-compat'
    ? config.worker.concurrency.openaiCompat
    : config.worker.concurrency.gemini
}

export interface IdleSlotCheck {
  provider: QueueProvider
  model: string
  userId: string
  now: number
  /**
   * 本轮调度已经选中、还没认领的任务：计入正在跑的数。它们在库里仍是 queued，所以别人的任务
   * 被选中的这一轮照样算「有人排队」，弹性名额等下一轮别人都跑起来之后再看。
   */
  planned?: ReadonlyArray<{ id: string; model: string }>
}

export type IdleSlotDecision =
  | { granted: true; runningOnProvider: number; runningInScope: number | null }
  | {
      granted: false
      reason: 'provider_full' | 'model_full' | 'others_waiting'
    }

/** 判定一个弹性名额。只读；防超发靠调用方先拿 `lockIdleSlotClaims`。 */
export async function checkIdleSlot(
  tx: BffTransaction,
  input: IdleSlotCheck,
): Promise<IdleSlotDecision> {
  const planned = input.planned ?? []
  const [running] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.provider, input.provider),
        eq(schema.tasks.kind, 'queue'),
        eq(schema.tasks.status, 'in_progress'),
      ),
    )
  const runningOnProvider = Number(running?.count ?? 0) + planned.length
  if (runningOnProvider + 1 > providerConcurrencyLimit(input.provider))
    return { granted: false, reason: 'provider_full' }

  let runningInScope: number | null = null
  const scope = taskConcurrencyScope(input.provider, input.model)
  if (scope) {
    const [inScope] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.provider, input.provider),
          eq(schema.tasks.kind, 'queue'),
          eq(schema.tasks.status, 'in_progress'),
          inArray(schema.tasks.model, scope.models),
        ),
      )
    runningInScope =
      Number(inScope?.count ?? 0) +
      planned.filter((task) => scope.models.includes(task.model)).length
    if (runningInScope + 1 > scope.limit) return { granted: false, reason: 'model_full' }
  }

  const [waiting] = await tx
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.provider, input.provider),
        eq(schema.tasks.kind, 'queue'),
        eq(schema.tasks.status, 'queued'),
        or(isNull(schema.tasks.next_retry_at), lte(schema.tasks.next_retry_at, input.now)),
        or(isNull(schema.tasks.user_id), ne(schema.tasks.user_id, input.userId)),
      ),
    )
    .limit(1)
  if (waiting) return { granted: false, reason: 'others_waiting' }
  return { granted: true, runningOnProvider, runningInScope }
}
