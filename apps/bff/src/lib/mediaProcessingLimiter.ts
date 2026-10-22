/** setTimeout 能精确表示的最长延迟。 */
const MAX_TIMER_MS = 2 ** 31 - 1

export interface MediaProcessingLimiterOptions {
  slots: number
  /** 在途原件合计字节上限，按最大安全整数封顶；第一张总能进，单张超限也不会永远排不上。 */
  byteBudget: () => number
  queueLimit: number
  queueTimeoutMs: number
  /** 放不下的那张等到这么久之后，后面放得下的不再插到它前面，等在途的放完让它进。 */
  bypassLimitMs: number
  /** 排满或排队超时时抛的错误（由调用方给出，保持对外错误码不变）。 */
  busy: (reason: 'processing_queue_full' | 'processing_queue_timeout') => Error
  /** 预算读取抛错或返回坏值时调用（每次由好变坏报一次），供调用方告警。 */
  onInvalidBudget?: (error: unknown) => void
  now?: () => number
}

interface Waiter {
  bytes: number
  queuedAt: number
  resume: () => void
  reject: () => void
}

/**
 * 确认用的处理位：按位数和字节限额准入。排队时不只看队首——队首的大图暂时放不下，
 * 后面放得下的小图先进；但大图等过 bypassLimitMs 后不再让后来者插队，避免一直饿着它。
 */
export function createMediaProcessingLimiter(options: MediaProcessingLimiterOptions) {
  for (const [name, value] of [
    ['slots', options.slots],
    ['queueLimit', options.queueLimit],
    ['queueTimeoutMs', options.queueTimeoutMs],
    ['bypassLimitMs', options.bypassLimitMs],
  ] as const)
    if (
      !Number.isSafeInteger(value) ||
      value < (name === 'slots' ? 1 : 0) ||
      // 两个时限都交给 setTimeout，超过 2^31-1 ms 会被 Node 截成约 1ms，排队的立刻超时。
      (name.endsWith('Ms') && value > MAX_TIMER_MS)
    )
      throw new RangeError(`invalid media processing ${name}`)
  // 三个回调（预算、时钟、busy）都由调用方给出、可能读动态配置：在限流器边界兜住它们的异常和坏值，
  // 不让定时器或 finally 里的 drain() 半路抛出，导致排队的请求永远等不到结果。
  const now = () => {
    try {
      const value = (options.now ?? Date.now)()
      return typeof value === 'number' && Number.isFinite(value) ? value : Date.now()
    } catch {
      return Date.now()
    }
  }
  const busy = (reason: 'processing_queue_full' | 'processing_queue_timeout') => {
    try {
      return options.busy(reason)
    } catch (error) {
      return error
    }
  }
  let active = 0
  let activeBytes = 0
  const queue: Waiter[] = []
  // 最近一次读到的合法预算。配置读取临时出错时沿用它，不把吞吐静默降成串行、让排队的一起超时；
  // 从没读到过合法值时才退到 0（一次只放一张），保证不突破内存上界。
  let lastGoodBudget: number | undefined
  let budgetBroken = false
  const budget = () => {
    let value: unknown
    let error: unknown
    try {
      value = options.byteBudget()
    } catch (caught) {
      error = caught
    }
    // 上限按最大安全整数算（Infinity 也一样），在途合计因此始终是精确的整数。
    if (error === undefined && typeof value === 'number' && !Number.isNaN(value) && value >= 0) {
      budgetBroken = false
      lastGoodBudget = Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER)
      return lastGoodBudget
    }
    if (!budgetBroken) {
      budgetBroken = true
      try {
        options.onInvalidBudget?.(
          error ?? new RangeError(`invalid media processing budget: ${String(value)}`),
        )
      } catch {}
    }
    return lastGoodBudget ?? 0
  }
  // 用减法比较：activeBytes 不超过预算（或只有一张在途），两数都是安全整数，差值精确，不会因相加舍入误放。
  const admits = (bytes: number) =>
    active < options.slots && (active === 0 || bytes <= budget() - activeBytes)
  const admit = (bytes: number) => {
    active++
    activeBytes += bytes
  }
  const drain = () => {
    for (let index = 0; index < queue.length && active < options.slots; ) {
      const waiter = queue[index]!
      if (admits(waiter.bytes)) {
        queue.splice(index, 1)
        admit(waiter.bytes)
        waiter.resume()
        continue
      }
      if (now() - waiter.queuedAt >= options.bypassLimitMs) break
      index++
    }
  }
  return {
    get active() {
      return active
    },
    get activeBytes() {
      return activeBytes
    },
    get queued() {
      return queue.length
    },
    async run<T>(bytes: number, work: () => Promise<T>): Promise<T> {
      // 计数只收非负整数：负数会低估在途字节，NaN 会让之后的准入判断永远不成立。
      if (!Number.isSafeInteger(bytes) || bytes < 0)
        throw new RangeError('invalid media processing bytes')
      if (!queue.length && admits(bytes)) admit(bytes)
      else {
        if (queue.length >= options.queueLimit) throw busy('processing_queue_full')
        await new Promise<void>((resolve, reject) => {
          const waiter: Waiter = {
            bytes,
            queuedAt: now(),
            resume: () => {
              clearTimeout(timer)
              resolve()
            },
            reject: () => {
              const index = queue.indexOf(waiter)
              if (index >= 0) queue.splice(index, 1)
              reject(busy('processing_queue_timeout'))
              // 挡在前面的那张离开后，后面的可能已经放得进。
              drain()
            },
          }
          const timer = setTimeout(waiter.reject, options.queueTimeoutMs)
          queue.push(waiter)
          drain()
        })
      }
      try {
        return await work()
      } finally {
        active--
        activeBytes -= bytes
        drain()
      }
    },
  }
}
