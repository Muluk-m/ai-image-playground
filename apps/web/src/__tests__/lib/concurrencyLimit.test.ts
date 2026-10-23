import { describe, expect, it } from 'vitest'
import { createConcurrencyLimit } from '../../lib/concurrencyLimit'

function deferred() {
  let resolve!: () => void
  let reject!: (err: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('并发上限', () => {
  it('最多同时跑 5 个，跑完一个才放下一个，按加入顺序', async () => {
    const limit = createConcurrencyLimit(5)
    const gates = Array.from({ length: 7 }, deferred)
    const started: number[] = []
    const done = gates.map((gate, index) =>
      limit.run(async () => {
        started.push(index)
        await gate.promise
      }),
    )
    await flush()
    expect(started).toEqual([0, 1, 2, 3, 4])
    expect(limit.active).toBe(5)
    expect(limit.waiting).toBe(2)

    gates[2].resolve()
    await flush()
    expect(started).toEqual([0, 1, 2, 3, 4, 5])
    expect(limit.waiting).toBe(1)

    for (const gate of gates) gate.resolve()
    await Promise.all(done)
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(limit.active).toBe(0)
  })

  it('失败的任务也会腾出位置', async () => {
    const limit = createConcurrencyLimit(1)
    const first = deferred()
    const started: string[] = []
    const a = limit.run(async () => {
      started.push('a')
      await first.promise
    })
    const b = limit.run(async () => {
      started.push('b')
    })
    await flush()
    expect(started).toEqual(['a'])
    first.reject(new Error('上游失败'))
    await Promise.all([a, b])
    expect(started).toEqual(['a', 'b'])
  })

  it('同步抛错也不会卡住队列', async () => {
    const limit = createConcurrencyLimit(1)
    let ran = false
    await limit.run(() => {
      throw new Error('boom')
    })
    await limit.run(async () => {
      ran = true
    })
    expect(ran).toBe(true)
  })
})
