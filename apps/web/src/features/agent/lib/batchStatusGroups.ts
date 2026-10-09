/** 批量执行时，把同一状态的处理项收成一组。顺序是用户先看正在发生的，再看要处理的，最后才是已经过去的。 */
export const BATCH_STATUS_ORDER = [
  'in_flight',
  'in_progress',
  'reconciling',
  'failed',
  'blocked',
  'queued',
  'ready',
  'pending',
  'completed',
  'cancelled',
] as const

export type BatchDisplayStatus = (typeof BATCH_STATUS_ORDER)[number]

export const BATCH_ITEM_PAGE_SIZE = 20

const LIVE = new Set<BatchDisplayStatus>(['in_flight', 'in_progress'])
const SHORT_ATTENTION = new Set<BatchDisplayStatus>(['queued', 'reconciling', 'blocked', 'failed'])

export function batchItemStatus(item: {
  readonly progress?: string
  readonly execution?: { readonly status: string }
}): BatchDisplayStatus {
  const raw = item.progress ?? item.execution?.status ?? 'pending'
  return (BATCH_STATUS_ORDER as readonly string[]).includes(raw)
    ? (raw as BatchDisplayStatus)
    : 'pending'
}

/**
 * 一次刷新里，只有当前聚焦的那一条换了状态才需要把焦点送回去。
 * 同一次轮询里后面其它展开条目也完成时，不能让它们抢走这个位置。
 */
export function focusedBatchItemStatusChange<T extends Parameters<typeof batchItemStatus>[0]>(
  items: readonly (T & { readonly key: string })[],
  previous: ReadonlyMap<string, string>,
  focusedKey: string | null,
): string | null {
  if (!focusedKey) return null
  const item = items.find((entry) => entry.key === focusedKey)
  if (!item) return null
  const before = previous.get(focusedKey)
  const status = batchItemStatus(item)
  return before && before !== status ? focusedKey : null
}

export interface BatchStatusGroup<T> {
  readonly status: BatchDisplayStatus
  readonly items: readonly T[]
}

export function groupBatchItems<
  T extends { readonly progress?: string; readonly execution?: { readonly status: string } },
>(items: readonly T[]): BatchStatusGroup<T>[] {
  const buckets = new Map<BatchDisplayStatus, T[]>()
  for (const item of items) {
    const status = batchItemStatus(item)
    const list = buckets.get(status)
    if (list) list.push(item)
    else buckets.set(status, [item])
  }
  return BATCH_STATUS_ORDER.filter((status) => buckets.has(status)).map((status) => ({
    status,
    items: buckets.get(status) ?? [],
  }))
}

/**
 * 只有一组时展开，方便直接改提示词。正在执行的保持展开。
 * 排队、失败、受阻只在条数少的时候展开；待派发和已完成默认收成计数，避免几十行相同状态铺满对话。
 * 含本次重试的组展开，重试标记才看得见。
 */
export function batchGroupStartsOpen(
  status: BatchDisplayStatus,
  count: number,
  groupCount: number,
  containsRetry: boolean,
): boolean {
  if (containsRetry || groupCount <= 1) return true
  if (LIVE.has(status)) return true
  return SHORT_ATTENTION.has(status) && count <= 8
}
