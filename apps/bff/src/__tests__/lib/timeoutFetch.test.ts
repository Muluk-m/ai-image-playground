import { describe, expect, it } from 'bun:test'
import { Agent } from 'undici'
import {
  agentOptions,
  createDispatcher,
  createFetchSlot,
  startDeadline,
  withDeadline,
} from '../../lib/timeoutFetch'

class CallerError extends Error {}

type StubFetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ status: number }>

describe('agentOptions', () => {
  it('applies the connect timeout on its own', () => {
    expect(agentOptions({ connectMs: 1_234 })).toEqual({ connectTimeout: 1_234 })
  })

  it('applies headers and body timeouts when a transport budget is given', () => {
    expect(agentOptions({ connectMs: 1_000, transportMs: 9_000 })).toEqual({
      connectTimeout: 1_000,
      headersTimeout: 9_000,
      bodyTimeout: 9_000,
    })
  })

  it('builds an undici Agent from those options', () => {
    expect(createDispatcher({ connectMs: 1_000, transportMs: 9_000 })).toBeInstanceOf(Agent)
  })
})

describe('createFetchSlot', () => {
  it('replaces the transport and restores the real one', async () => {
    const slot = createFetchSlot<StubFetch>()
    const real = slot.current

    slot.set(async () => ({ status: 418 }))
    expect(await slot.current('https://example.test')).toEqual({ status: 418 })

    slot.set()
    expect(slot.current).toBe(real)
  })
})

describe('withDeadline', () => {
  it('aborts the signal once the budget runs out', async () => {
    const aborted = await withDeadline(5, (signal) => {
      return new Promise<boolean>((resolve) => {
        signal.addEventListener('abort', () => resolve(true), { once: true })
      })
    })
    expect(aborted).toBe(true)
  })

  it('lets the caller map the abort onto its own error class', async () => {
    const run = withDeadline(5, async (signal) => {
      try {
        await new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            {
              once: true,
            },
          )
        })
      } catch (error) {
        throw new CallerError('upstream unreachable', { cause: error })
      }
    })
    await expect(run).rejects.toBeInstanceOf(CallerError)
  })

  it('leaves the signal untouched when the call finishes first', async () => {
    let seen: AbortSignal | undefined
    await withDeadline(10_000, async (signal) => {
      seen = signal
    })
    await Bun.sleep(5)
    expect(seen?.aborted).toBe(false)
  })
})

describe('startDeadline', () => {
  it('reports a timeout apart from any other abort', async () => {
    const deadline = startDeadline(5)
    expect(deadline.timedOut).toBe(false)
    await Bun.sleep(20)
    expect(deadline.signal.aborted).toBe(true)
    expect(deadline.timedOut).toBe(true)
    deadline.release()
  })

  it('does not call a manual abort a timeout', () => {
    const deadline = startDeadline(10_000)
    deadline.abort()
    expect(deadline.signal.aborted).toBe(true)
    expect(deadline.timedOut).toBe(false)
    deadline.release()
  })

  it('relays an external cancellation without marking it a timeout', () => {
    const external = new AbortController()
    const deadline = startDeadline(10_000, external.signal)
    external.abort()
    expect(deadline.signal.aborted).toBe(true)
    expect(deadline.timedOut).toBe(false)
    deadline.release()
  })

  it('starts aborted when the external signal already is', () => {
    const external = new AbortController()
    external.abort()
    const deadline = startDeadline(10_000, external.signal)
    expect(deadline.signal.aborted).toBe(true)
    deadline.release()
  })

  it('stops the timer on release', async () => {
    const deadline = startDeadline(5)
    deadline.release()
    await Bun.sleep(20)
    expect(deadline.signal.aborted).toBe(false)
    expect(deadline.timedOut).toBe(false)
  })
})
