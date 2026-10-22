export interface MediaProcessingLimiterOptions {
  slots: number
  /** 在途原件合计字节上限；第一张总能进，单张超限也不会永远排不上。 */
  byteBudget: () => number
  queueLimit: number
  queueTimeoutMs: number
  /** 放不下的那张等到这么久之后，后面放得下的不再插到它前面，等在途的放完让它进。 */
  bypassLimitMs: number
  /** 排满或排队超时时抛的错误（由调用方给出，保持对外错误码不变）。 */
  busy: (reason: 'processing_queue_full' | 'processing_queue_timeout') => Error
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
    if (!Number.isSafeInteger(value) || value < (name === 'slots' ? 1 : 0))
      throw new RangeError(`invalid media processing ${name}`)
  const now = options.now ?? Date.now
  let active = 0
  let activeBytes = 0
  const queue: Waiter[] = []
  const budget = () => {
    const value = options.byteBudget()
    // 预算配置坏了（NaN、负数）时只放一张，不让队列一直超时也不突破内存上界。
    return Number.isFinite(value) && value >= 0 ? value : 0
  }
  const admits = (bytes: number) =>
    active < options.slots && (active === 0 || activeBytes + bytes <= budget())
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
        if (queue.length >= options.queueLimit) throw options.busy('processing_queue_full')
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
              reject(options.busy('processing_queue_timeout'))
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
