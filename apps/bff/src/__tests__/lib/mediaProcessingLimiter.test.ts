import { describe, expect, it } from 'bun:test'
import { createMediaProcessingLimiter } from '../../lib/mediaProcessingLimiter'

function gate() {
  let open!: () => void
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { open, opened }
}

function limiter(overrides: { now?: () => number; queueTimeoutMs?: number } = {}) {
  return createMediaProcessingLimiter({
    slots: 4,
    byteBudget: () => 100,
    queueLimit: 8,
    queueTimeoutMs: overrides.queueTimeoutMs ?? 10_000,
    bypassLimitMs: 5_000,
    busy: (reason) => new Error(reason),
    now: overrides.now,
  })
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('media processing limiter', () => {
  it('队首大图暂时放不下时，后面放得下的小图先进，不被挡住', async () => {
    const subject = limiter()
    const running = gate()
    const started: string[] = []
    const job = (name: string, bytes: number) =>
      subject.run(bytes, async () => {
        started.push(name)
        await running.opened
      })
    const jobs = [job('small-1', 30), job('big', 90), job('small-2', 30), job('small-3', 30)]
    await tick()
    // 30 在途，90 放不下（30 + 90 > 100）；两张 30 合计 90 仍在限额内，先进。
    expect(started).toEqual(['small-1', 'small-2', 'small-3'])
    expect(subject.queued).toBe(1)
    running.open()
    await Promise.all(jobs)
    expect(started).toEqual(['small-1', 'small-2', 'small-3', 'big'])
    expect(subject.active).toBe(0)
    expect(subject.activeBytes).toBe(0)
  })

  it('大图等过插队上限后，后来的小图不再插到它前面，在途放完它就能进', async () => {
    let clock = 0
    const subject = limiter({ now: () => clock })
    const first = gate()
    const started: string[] = []
    const job = (name: string, bytes: number, until: Promise<void>) =>
      subject.run(bytes, async () => {
        started.push(name)
        await until
      })
    const later = gate()
    const jobs = [job('small-1', 30, first.opened), job('big', 90, later.opened)]
    await tick()
    clock = 5_000
    jobs.push(job('small-2', 30, later.opened))
    await tick()
    expect(started).toEqual(['small-1'])
    first.open()
    await jobs[0]
    await tick()
    expect(started).toEqual(['small-1', 'big'])
    later.open()
    await Promise.all(jobs)
    expect(started).toEqual(['small-1', 'big', 'small-2'])
  })

  it('最多 4 张同时在途，第一张总能进（单张超限也不会永远排不上）', async () => {
    const subject = limiter()
    const running = gate()
    let peak = 0
    const job = (bytes: number) =>
      subject.run(bytes, async () => {
        peak = Math.max(peak, subject.active)
        await running.opened
      })
    const huge = job(500)
    await tick()
    expect(subject.active).toBe(1)
    running.open()
    await huge
    const second = gate()
    const many = Array.from({ length: 6 }, () =>
      subject.run(10, async () => {
        peak = Math.max(peak, subject.active)
        await second.opened
      }),
    )
    await tick()
    expect(subject.active).toBe(4)
    expect(subject.queued).toBe(2)
    second.open()
    await Promise.all(many)
    expect(peak).toBe(4)
  })

  it('排队超时报忙并离开队列；排满时直接报忙', async () => {
    const subject = limiter({ queueTimeoutMs: 20 })
    const running = gate()
    const started: string[] = []
    const holder = subject.run(60, async () => {
      started.push('holder')
      await running.opened
    })
    await tick()
    const big = subject.run(90, async () => {
      started.push('big')
    })
    await expect(big).rejects.toThrow('processing_queue_timeout')
    expect(subject.queued).toBe(0)
    const fillers = Array.from({ length: 8 }, () =>
      subject.run(60, async () => {
        await running.opened
      }),
    )
    await tick()
    await expect(subject.run(60, async () => {})).rejects.toThrow('processing_queue_full')
    running.open()
    await holder
    await Promise.allSettled(fillers)
    expect(started).toEqual(['holder'])
  })
})

describe('media processing limiter input checks', () => {
  it('拒收无效的字节数与参数；预算配置坏了时一次只放一张', async () => {
    const subject = limiter()
    await expect(subject.run(Number.NaN, async () => {})).rejects.toThrow(RangeError)
    await expect(subject.run(-1, async () => {})).rejects.toThrow(RangeError)
    expect(subject.activeBytes).toBe(0)
    expect(() =>
      createMediaProcessingLimiter({
        slots: 0,
        byteBudget: () => 100,
        queueLimit: 8,
        queueTimeoutMs: 10,
        bypassLimitMs: 5,
        busy: (reason) => new Error(reason),
      }),
    ).toThrow(RangeError)
    const broken = createMediaProcessingLimiter({
      slots: 4,
      byteBudget: () => Number.NaN,
      queueLimit: 8,
      queueTimeoutMs: 10_000,
      bypassLimitMs: 5_000,
      busy: (reason) => new Error(reason),
    })
    const running = gate()
    const jobs = [1, 2].map(() => broken.run(1, () => running.opened))
    await tick()
    expect(broken.active).toBe(1)
    running.open()
    await Promise.all(jobs)
    expect(broken.active).toBe(0)
  })

  it('预算读取临时出错时沿用上次的合法值并告警一次，不降成串行', async () => {
    let broken = false
    const warnings: unknown[] = []
    const subject = createMediaProcessingLimiter({
      slots: 4,
      byteBudget: () => {
        if (broken) throw new Error('config unavailable')
        return 100
      },
      queueLimit: 8,
      queueTimeoutMs: 10_000,
      bypassLimitMs: 5_000,
      busy: (reason) => new Error(reason),
      onInvalidBudget: (error) => warnings.push(error),
    })
    const running = gate()
    // 第一张不读预算就进；第二张读到 100，记为最近的合法值。
    const jobs = [1, 2].map(() => subject.run(10, () => running.opened))
    await tick()
    expect(subject.active).toBe(2)
    broken = true
    jobs.push(
      subject.run(10, () => running.opened),
      subject.run(10, () => running.opened),
    )
    await tick()
    expect(subject.active).toBe(4)
    expect(warnings).toHaveLength(1)
    running.open()
    await Promise.all(jobs)
  })

  it('拒收 setTimeout 表示不了的时限；超大预算截到安全整数，在途合计保持精确', async () => {
    const options = {
      slots: 4,
      byteBudget: () => 100,
      queueLimit: 8,
      queueTimeoutMs: 10_000,
      bypassLimitMs: 5_000,
      busy: (reason: string) => new Error(reason),
    }
    expect(() => createMediaProcessingLimiter({ ...options, queueTimeoutMs: 2 ** 31 })).toThrow(
      RangeError,
    )
    expect(() => createMediaProcessingLimiter({ ...options, bypassLimitMs: 2 ** 31 })).toThrow(
      RangeError,
    )
    expect(() =>
      createMediaProcessingLimiter({ ...options, queueTimeoutMs: 2 ** 31 - 1 }),
    ).not.toThrow()
    const huge = createMediaProcessingLimiter({ ...options, byteBudget: () => 2 ** 60 })
    const running = gate()
    const first = huge.run(Number.MAX_SAFE_INTEGER, () => running.opened)
    // 预算按 MAX_SAFE_INTEGER 算：再多 1 字节也放不下，不会因为相加舍入被误放。
    const second = huge.run(1, async () => {})
    await tick()
    expect(huge.active).toBe(1)
    expect(huge.activeBytes).toBe(Number.MAX_SAFE_INTEGER)
    running.open()
    await Promise.all([first, second])
    expect(huge.activeBytes).toBe(0)
    // Infinity 不是坏配置：按最大安全整数封顶，照常并行。
    const unlimited = createMediaProcessingLimiter({ ...options, byteBudget: () => Infinity })
    const held = gate()
    const jobs = [1, 2, 3].map(() => unlimited.run(1_000, () => held.opened))
    await tick()
    expect(unlimited.active).toBe(3)
    held.open()
    await Promise.all(jobs)
  })

  it('回调抛错或返回坏值时，排队的请求照样有结果，队列继续往下走', async () => {
    let clock = 0
    let budgetCalls = 0
    const subject = createMediaProcessingLimiter({
      slots: 4,
      byteBudget: () => {
        budgetCalls++
        if (budgetCalls % 2) throw new Error('config unavailable')
        return undefined as unknown as number
      },
      queueLimit: 8,
      queueTimeoutMs: 20,
      bypassLimitMs: 5_000,
      busy: () => {
        throw new Error('busy factory failed')
      },
      now: () => {
        clock++
        if (clock % 3 === 0) throw new Error('clock unavailable')
        return Number.NaN
      },
    })
    const running = gate()
    // 预算读不出来按 0：一次只放一张；第二张排队、超时时 busy 抛错也要以那个错误结束。
    const first = subject.run(10, () => running.opened)
    const second = subject.run(10, async () => 'second')
    await expect(second).rejects.toThrow('busy factory failed')
    expect(subject.queued).toBe(0)
    const third = subject.run(10, async () => 'third')
    running.open()
    await first
    expect(await third).toBe('third')
    expect(subject.active).toBe(0)
    expect(subject.activeBytes).toBe(0)
  })
})
