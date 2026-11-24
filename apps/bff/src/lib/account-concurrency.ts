import type { AgentJobQueuePosition } from '@image-playground/shared'
import { type BffTransaction, loadEntitlementPort } from './billing-ports'

/**
 * 这个账号此刻能同时生成几张。由部署的计费层按套餐给出（没订阅是 1）；没有计费层时是 3。
 * 调度认这个数，任务卡上「前面还有几张」也认这个数，两处说的是同一件事。
 */
export async function accountConcurrencyLimit(
  tx: BffTransaction,
  userId: string,
  now: number,
): Promise<number> {
  const entitlement = await loadEntitlementPort()
  const entitled = (await entitlement.accountConcurrencyLimit?.({ tx, userId, now })) ?? 3
  return Number.isInteger(entitled) && entitled > 0 ? entitled : 1
}

/**
 * 解析保证并发与弹性并发的组合，得出客户端可并行提交的上限。
 * 未开启弹性并发或未给出弹性名额时退回保证并发。
 */
export function resolveEffectiveConcurrency(
  guaranteed: number | undefined,
  idle: number | undefined,
  idleEnabled: boolean,
): number {
  const base = Number.isInteger(guaranteed) && (guaranteed ?? 0) > 0 ? guaranteed! : 1
  if (!idleEnabled || !Number.isInteger(idle) || (idle ?? 0) <= base) return base
  return idle!
}

/**
 * 账号在开启弹性空闲并发时的最大可并行数（CLI capabilities 告知客户端可并行提交的上限）。
 * 未开启弹性并发或私有层未提供弹性名额时，退回保证并发 `accountConcurrencyLimit`。
 */
export async function accountEffectiveConcurrencyLimit(
  tx: BffTransaction,
  userId: string,
  now: number,
  idleConcurrencyEnabled: boolean,
): Promise<number> {
  const port = await loadEntitlementPort()
  if (!idleConcurrencyEnabled || !port.accountConcurrencyEntitlement) {
    return accountConcurrencyLimit(tx, userId, now)
  }
  const entitlement = await port.accountConcurrencyEntitlement({ tx, userId, now })
  return resolveEffectiveConcurrency(
    entitlement.guaranteed,
    entitlement.idle,
    idleConcurrencyEnabled,
  )
}

/** 本账号还没出完的一条生成任务：在生成的，或还在排队的。 */
export interface AccountQueueTask {
  readonly id: string
  readonly status: 'queued' | 'in_progress'
  readonly submittedAt: number
  /** 失败后等重试的时刻；没到之前调度不会挑它，也就不占前面的位置。 */
  readonly nextRetryAt?: number | null
}

/**
 * 每条排队任务前面还有几张：在生成的全算，排队的只算比它先提交、且重试时间已到的（同一刻按 id）。
 * 这是账号维度的近似：调度还会按供应商槽位分轮挑，跨供应商时实际先后可能略有出入。
 * 只给 `targets` 里还在排队的那几条。
 */
export function accountQueuePositions(
  targets: readonly string[],
  unfinished: readonly AccountQueueTask[],
  limit: number,
  now: number = Date.now(),
): Map<string, AgentJobQueuePosition> {
  const running = unfinished.filter((task) => task.status === 'in_progress').length
  const queued = unfinished
    .filter((task) => task.status === 'queued')
    .sort((a, b) => a.submittedAt - b.submittedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const wanted = new Set(targets)
  const positions = new Map<string, AgentJobQueuePosition>()
  let dueAhead = 0
  for (const task of queued) {
    // 还在等重试时间的任务调度暂时不挑：不算排在别人前面，自己也不报位置。
    if (task.nextRetryAt != null && task.nextRetryAt > now) continue
    if (wanted.has(task.id)) positions.set(task.id, { ahead: running + dueAhead, limit })
    dueAhead++
  }
  return positions
}
