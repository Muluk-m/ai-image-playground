let ready = false
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/** 本机作品记录已经写进 store（失败也算结束），首页可以撤掉骨架。 */
export function markHistoryReady(): void {
  if (ready) return
  ready = true
  emit()
}

export function isHistoryReady(): boolean {
  return ready
}

export function subscribeHistoryReady(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
