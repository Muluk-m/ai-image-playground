/**
 * 用户这次主动发送、新任务行已经插入之后，作品卡要滚进视野并高亮。
 * 只由发送入口写入（首页快速生成、同一颗发送按钮上的模板）。
 * 启动恢复、登录后续跑、轮询更新、翻页都不得调用。
 */

const HIGHLIGHT_MS = 1500
const EMPTY: readonly string[] = []

let ids: string[] = []
let snapshot: readonly string[] = EMPTY
const listeners = new Set<() => void>()
const timers = new Map<string, number>()

function emit(): void {
  snapshot = ids.length === 0 ? EMPTY : ids.slice()
  for (const listener of listeners) listener()
}

/** 高亮持续这么久后自行撤下，网格卸掉了也一样，避免回到首页时再闪一次。 */
export const SUBMITTED_TASK_HIGHLIGHT_MS = HIGHLIGHT_MS

export function noteUserSubmittedTasks(taskIds: readonly string[]): void {
  const fresh = [...new Set(taskIds.filter((id) => id && !ids.includes(id)))]
  if (fresh.length === 0) return
  ids = [...ids, ...fresh]
  emit()
  if (typeof window === 'undefined') return
  for (const id of fresh) {
    const handle = window.setTimeout(() => {
      timers.delete(id)
      dismissSubmittedTasks([id])
    }, HIGHLIGHT_MS)
    timers.set(id, handle)
  }
}

export function dismissSubmittedTasks(taskIds: readonly string[]): void {
  if (typeof window !== 'undefined') {
    for (const id of taskIds) {
      const handle = timers.get(id)
      if (handle === undefined) continue
      window.clearTimeout(handle)
      timers.delete(id)
    }
  }
  if (!ids.some((id) => taskIds.includes(id))) return
  const drop = new Set(taskIds)
  ids = ids.filter((id) => !drop.has(id))
  emit()
}

export function submittedTaskSnapshot(): readonly string[] {
  return snapshot
}

export function submittedTaskServerSnapshot(): readonly string[] {
  return EMPTY
}

export function subscribeSubmittedTasks(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/**
 * 卡片还没布局，或四边都在视口内：不滚。
 * 有一边被裁掉时用 `scrollIntoView({ block: 'nearest' })` 只补齐缺的那一截，不把已经看见的卡片拽到中间。
 */
export function cardNeedsScroll(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return false
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight
  return rect.top < 0 || rect.left < 0 || rect.bottom > viewportHeight || rect.right > viewportWidth
}

export function revealSubmittedCard(element: HTMLElement): void {
  if (cardNeedsScroll(element)) {
    element.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    })
  }
  element.focus({ preventScroll: true })
}
