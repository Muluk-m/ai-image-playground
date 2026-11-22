import type { LedgerEntry } from '@image-playground/shared'

/**
 * 变动为 0、也没写备注的流水不给运营看：绝大多数是任务结算时「预扣刚好等于实际消耗」，
 * 一个任务一条，没有信息量却占满了表格。带备注的零变动（例如「套餐积分已过期，未退回」）照样展示。
 * 只是不展示，接口和数据都不动：结算记录还带着上游调用次数，是对账依据。
 */
export function isSilentZero(entry: Pick<LedgerEntry, 'amount' | 'note'>): boolean {
  return entry.amount === 0 && !entry.note?.trim()
}

export function visibleLedger<T extends Pick<LedgerEntry, 'amount' | 'note'>>(
  entries: T[],
): { shown: T[]; hidden: number } {
  const shown = entries.filter((entry) => !isSilentZero(entry))
  return { shown, hidden: entries.length - shown.length }
}
