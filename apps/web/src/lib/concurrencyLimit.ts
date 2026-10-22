/**
 * 同时最多跑 `max` 个任务，其余按加入顺序排队；跑完一个（成功或失败）才放下一个进来。
 */
export interface ConcurrencyLimit {
  run(job: () => Promise<void>): Promise<void>
  readonly active: number
  readonly waiting: number
}

export function createConcurrencyLimit(max: number): ConcurrencyLimit {
  const limit = Math.max(1, Math.floor(max))
  const queue: Array<() => void> = []
  let active = 0

  const next = () => {
    if (active >= limit) return
    const start = queue.shift()
    if (start) start()
  }

  return {
    run(job) {
      return new Promise<void>((resolve) => {
        queue.push(() => {
          active++
          // 任务自己的错误由任务处理；限流器只管腾位置，不让一次失败卡住后面的。
          Promise.resolve()
            .then(job)
            .catch(() => {})
            .finally(() => {
              active--
              resolve()
              next()
            })
        })
        next()
      })
    },
    get active() {
      return active
    },
    get waiting() {
      return queue.length
    },
  }
}
