/** 没有记下进入时刻的旧行按已经到期处理，避免再次放着不管。 */
export function reconcilingDue(since: number | null, now: number, waitMs: number): boolean {
  return since === null || now - since >= waitMs
}

/**
 * 只有真正问过上游、并且上游没有可交付结果，才失败退款。
 * 没有上游任务号时查询根本没发出去，不能当成「确认没有结果」。
 */
export function shouldConfirmNoResult(
  reason: string | undefined,
  upstreamTaskCount: number,
): boolean {
  return reason === 'manual_verification_required' && upstreamTaskCount > 0
}
