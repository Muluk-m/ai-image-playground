/**
 * 批次卡片自己知道计划还是不是草稿。输入栏要拦「确认」这种短句时读这里，
 * 不在每次按键时再去请求批次状态。
 *
 * 快照必须换新的 Set：同一引用被原地改写时，订阅者看不出变化。
 */
let snapshot: ReadonlySet<string> = new Set()
const listeners = new Set<() => void>()

export function batchDraftSnapshot(): ReadonlySet<string> {
  return snapshot
}

export function subscribeBatchDrafts(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function noteBatchAwaitingConfirmation(batchId: string, awaiting: boolean): void {
  if (snapshot.has(batchId) === awaiting) return
  const next = new Set(snapshot)
  if (awaiting) next.add(batchId)
  else next.delete(batchId)
  snapshot = next
  for (const listener of listeners) listener()
}

/** 测试之间清掉上一例留下的草稿批次。 */
export function resetBatchDraftsForTesting(): void {
  snapshot = new Set()
  for (const listener of listeners) listener()
}
