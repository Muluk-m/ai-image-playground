import { QUEUE_TIMEOUTS } from '@image-playground/shared'

/** 没有记下进入时刻的旧行按已经到期处理，避免再次放着不管。 */
export function reconcilingDue(since: number | null, now: number, waitMs: number): boolean {
  return since === null || now - since >= waitMs
}

/**
 * 只有核对已经问到上游、并且返回的内容里没有可交付图片，才失败退款。
 * `manual_verification_required` 表示查询有了响应，但结果不合格。
 * 上游仍在生成时，一次性终查会超时，记成 `upstream_result_unknown`，不会走进这里。
 * 没有上游任务号时查询根本没发出去，同样不能退款。
 */
export function shouldConfirmNoResult(
  reason: string | undefined,
  upstreamTaskCount: number,
): boolean {
  return reason === 'manual_verification_required' && upstreamTaskCount > 0
}

/**
 * 核对一次之后，下一次再问上游的时刻。
 * 30 分钟告警发出前保持 5 分钟，避免长退避把告警拖过点；发出后逐级拉开，
 * 少数永远对不上的任务就不会占满每一轮的名额。
 */
export function nextAutoReconcileAt(
  startedAt: number | null,
  alertedAt: number | null,
  now: number,
): number {
  if (alertedAt === null) return now + QUEUE_TIMEOUTS.AUTO_RECONCILE_AFTER_MS
  const age = startedAt === null ? 0 : Math.max(0, now - startedAt)
  const wait = age < 60 * 60_000 ? 10 * 60_000 : age < 3 * 60 * 60_000 ? 20 * 60_000 : 30 * 60_000
  return now + wait
}
