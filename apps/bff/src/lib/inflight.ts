/**
 * 进程内的 in-flight task promise 跟踪表。
 *
 * 用途：submit endpoint 和启动恢复都以 fire-and-forget 方式调 `runTask`；
 * SIGTERM 时需要等这些任务跑完再退出，否则进程一死会留下 `in_progress` 孤儿
 * 让前端看到「BFF 重启时中断」。
 *
 * 单进程单实例。在 BFF 横向扩展前都用 module-level singleton 就够了。
 */

const inflight = new Set<Promise<void>>()

/**
 * 把 runTask 的 Promise 注册进跟踪表。Promise settle 后自动出栈。
 * 调用方应该已经在 promise 上挂了 `.catch`；这里不再额外吞错。
 */
export function trackTask(promise: Promise<void>): Promise<void> {
  inflight.add(promise)
  promise.finally(() => inflight.delete(promise))
  return promise
}

export function inflightCount(): number {
  return inflight.size
}

/** 返回当前快照；调用者持有引用后即使 inflight 集合自身被改也不影响等待。 */
export function inflightSnapshot(): Promise<void>[] {
  return Array.from(inflight)
}
