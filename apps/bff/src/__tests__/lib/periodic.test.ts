import { afterEach, describe, expect, it } from 'bun:test'
import { runPeriodicSteps, startPeriodicSteps } from '../../lib/periodic'

let stop: (() => void) | undefined
afterEach(() => {
  stop?.()
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
})
