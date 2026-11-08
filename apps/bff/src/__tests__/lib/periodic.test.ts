import { afterEach, describe, expect, it } from 'bun:test'
import { runPeriodicSteps, startPeriodicSteps } from '../../lib/periodic'

let stop: (() => Promise<void>) | undefined
afterEach(() => {
  void stop?.()
  stop = undefined
})

describe('periodic maintenance steps', () => {
  it('keeps running later steps when an earlier one rejects, and never rejects itself', async () => {
    const ran: string[] = []
    const failures: string[] = []
    await runPeriodicSteps(
      [
        {
          event: 'first',
          run: async () => {
            throw new Error('connection reset')
          },
        },
        { event: 'second', run: async () => void ran.push('second') },
      ],
      (event) => failures.push(event),
    )
    expect(ran).toEqual(['second'])
    expect(failures).toEqual(['first'])
  })

  it('skips a tick while the previous one is still running', async () => {
    let calls = 0
    let release: () => void = () => {}
    stop = startPeriodicSteps(5, [
      {
        event: 'slow',
        run: () => {
          calls += 1
          return new Promise<void>((resolve) => {
            release = resolve
          })
        },
      },
    ])
    await Bun.sleep(30)
    expect(calls).toBe(1)
    release()
    await Bun.sleep(15)
    expect(calls).toBeGreaterThan(1)
  })

  it('starts the initial steps in the background and skips ticks until they finish', async () => {
    const ran: string[] = []
    let release: () => void = () => {}
    stop = startPeriodicSteps(5, [{ event: 'tick', run: async () => void ran.push('tick') }], {
      initial: [
        {
          event: 'startup',
          run: () => {
            ran.push('startup')
            return new Promise<void>((resolve) => {
              release = resolve
            })
          },
        },
      ],
    })
    // 启动时不等开机清理：返回时它已开跑但还没完成。
    expect(ran).toEqual(['startup'])
    await Bun.sleep(30)
    expect(ran).toEqual(['startup'])
    release()
    await Bun.sleep(20)
    expect(ran.filter((one) => one === 'tick').length).toBeGreaterThan(0)
  })

  it('keeps ticking after the initial steps fail', async () => {
    const ran: string[] = []
    stop = startPeriodicSteps(5, [{ event: 'tick', run: async () => void ran.push('tick') }], {
      initial: [
        {
          event: 'startup',
          run: async () => {
            throw new Error('statement timeout')
          },
        },
      ],
    })
    await Bun.sleep(30)
    expect(ran.length).toBeGreaterThan(0)
  })

  it('waits for the in-flight run when stopped and schedules nothing after', async () => {
    let calls = 0
    let release: () => void = () => {}
    const stopNow = startPeriodicSteps(5, [{ event: 'tick', run: async () => void calls++ }], {
      initial: [
        {
          event: 'startup',
          run: () =>
            new Promise<void>((resolve) => {
              release = resolve
            }),
        },
      ],
    })
    let stopped = false
    const stopping = stopNow().then(() => {
      stopped = true
    })
    await Bun.sleep(20)
    expect(stopped).toBe(false)
    release()
    await stopping
    expect(stopped).toBe(true)
    await Bun.sleep(20)
    expect(calls).toBe(0)
  })
})
