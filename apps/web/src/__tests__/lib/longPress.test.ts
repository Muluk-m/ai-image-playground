// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLongPress } from '../../lib/longPress'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('long press', () => {
  it('fires at the press point once the finger has held still', () => {
    const onLongPress = vi.fn()
    const longPress = createLongPress(onLongPress, { delayMs: 500 })

    longPress.start({ x: 10, y: 20 })
    vi.advanceTimersByTime(499)
    expect(onLongPress).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onLongPress).toHaveBeenCalledWith({ x: 10, y: 20 })
  })

  it('yields to a drag once the finger moves past the tolerance', () => {
    const onLongPress = vi.fn()
    const longPress = createLongPress(onLongPress, { delayMs: 500, moveTolerancePx: 6 })

    longPress.start({ x: 10, y: 20 })
    longPress.move({ x: 15, y: 20 })
    vi.advanceTimersByTime(500)
    expect(onLongPress).toHaveBeenCalledTimes(1)

    longPress.start({ x: 10, y: 20 })
    longPress.move({ x: 20, y: 20 })
    vi.advanceTimersByTime(500)
    expect(onLongPress).toHaveBeenCalledTimes(1)
  })

  it('drops the press when the finger lifts early', () => {
    const onLongPress = vi.fn()
    const longPress = createLongPress(onLongPress, { delayMs: 500 })

    longPress.start({ x: 10, y: 20 })
    vi.advanceTimersByTime(300)
    longPress.cancel()
    vi.advanceTimersByTime(500)

    expect(onLongPress).not.toHaveBeenCalled()
  })
})
