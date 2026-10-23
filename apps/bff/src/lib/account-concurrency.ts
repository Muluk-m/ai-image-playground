import type { AgentJobQueuePosition } from '@image-playground/shared'
import { type BffTransaction, loadPrivateBffOverlay } from './private-overlay'

/**
 * 这个账号此刻能同时生成几张。由部署的计费层按套餐给出（没订阅是 1）；没有计费层时是 3。
 * 调度认这个数，任务卡上「前面还有几张」也认这个数，两处说的是同一件事。
 */
export async function accountConcurrencyLimit(
  tx: BffTransaction,
  userId: string,
  now: number,
): Promise<number> {
  const overlay = await loadPrivateBffOverlay()
  const entitled = (await overlay.taskHooks.accountConcurrencyLimit?.({ tx, userId, now })) ?? 3
  return Number.isInteger(entitled) && entitled > 0 ? entitled : 1
}

/** 本账号还没出完的一条生成任务：在生成的，或还在排队的。 */
export interface AccountQueueTask {
  readonly id: string
  readonly status: 'queued' | 'in_progress'
  readonly submittedAt: number
}

/**
 * 每条排队任务前面还有几张：在生成的全算，排队的只算比它先提交的（同一刻按 id），
 * 与调度挑任务的先后一致。只给 `targets` 里还在排队的那几条。
 */
export function accountQueuePositions(
  targets: readonly string[],
  unfinished: readonly AccountQueueTask[],
  limit: number,
): Map<string, AgentJobQueuePosition> {
  const running = unfinished.filter((task) => task.status === 'in_progress').length
  const queued = unfinished
    .filter((task) => task.status === 'queued')
    .sort((a, b) => a.submittedAt - b.submittedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const wanted = new Set(targets)
  const positions = new Map<string, AgentJobQueuePosition>()
  queued.forEach((task, index) => {
    if (wanted.has(task.id)) positions.set(task.id, { ahead: running + index, limit })
  })
  return positions
}
