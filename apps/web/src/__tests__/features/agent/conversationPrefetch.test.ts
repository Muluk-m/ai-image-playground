// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { prefetchPolicy } from '../../../features/agent/lib/conversationCachePolicy'
import { createConversationPrefetch } from '../../../features/agent/lib/conversationPrefetch'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
const catalog = ['newest', 'older', 'oldest'].map((id, i) => ({
  id,
  title: id,
  createdAt: i,
  updatedAt: 3 - i,
}))
function setup(
  fill = vi.fn(
    async (_id: string, _signal: AbortSignal): Promise<'done' | 'stop' | 'retry' | 'defer'> =>
      'done',
  ),
) {
  let available = true
  const runner = createConversationPrefetch({
    available: () => available,
    schedule(work, delay) {
      const timer = setTimeout(work, delay)
      return () => clearTimeout(timer)
    },
    fill,
  })
  return {
    runner,
    fill,
    available(value: boolean) {
      available = value
      runner.activity()
    },
  }
}
const tick = () => vi.advanceTimersByTimeAsync(prefetchPolicy.idleMs)

it('fills unopened history serially, waits between items and skips the foreground conversation', async () => {
  const { runner, fill } = setup()
  runner.update(catalog, false, 'newest')
  expect(fill).not.toHaveBeenCalled()
  await tick()
  expect(fill.mock.calls.map(([id]) => id)).toEqual(['older'])
  await tick()
  expect(fill.mock.calls.map(([id]) => id)).toEqual(['older', 'oldest'])
  await tick()
  expect(fill).toHaveBeenCalledTimes(2)
  runner.stop()
})
it('aborts in flight for foreground work, then resumes the interrupted history after a quiet interval', async () => {
  const fill = vi.fn(
    (_id: string, signal: AbortSignal) =>
      new Promise<'done'>((resolve) => signal.addEventListener('abort', () => resolve('done'))),
  )
  const { runner } = setup(fill)
  runner.update(catalog, false, null)
  await tick()
  runner.update(catalog, true, 'older')
  expect(fill.mock.calls[0][1].aborted).toBe(true)
  await vi.advanceTimersByTimeAsync(60000)
  expect(fill).toHaveBeenCalledTimes(1)
  runner.update(catalog, false, 'older')
  await tick()
  expect(fill.mock.calls.map(([id]) => id)).toEqual(['newest', 'newest'])
  runner.stop()
})
it('typing postpones work and does not consume attempts when interrupted', async () => {
  const { runner, fill } = setup()
  runner.update(catalog, false, null)
  await vi.advanceTimersByTimeAsync(prefetchPolicy.idleMs - 1)
  runner.activity()
  await vi.advanceTimersByTimeAsync(prefetchPolicy.idleMs - 1)
  expect(fill).not.toHaveBeenCalled()
  await tick()
  expect(fill).toHaveBeenCalledTimes(1)
  runner.stop()
})
it('pauses offline, hidden or on a restricted connection and wakes when eligible', async () => {
  const { runner, fill, available } = setup()
  available(false)
  runner.update(catalog, false, null)
  await tick()
  expect(fill).not.toHaveBeenCalled()
  available(true)
  await tick()
  expect(fill).toHaveBeenCalledTimes(1)
  runner.stop()
})
it('stops without downloading the rest when capacity or storage is unavailable', async () => {
  const { runner, fill } = setup(vi.fn(async () => 'stop' as const))
  runner.update(catalog, false, null)
  await vi.runAllTimersAsync()
  runner.update([...catalog], false, null)
  await tick()
  expect(fill).toHaveBeenCalledTimes(1)
  runner.stop()
})
it('backs off failed requests, bounds retries and continues to older histories', async () => {
  const { runner, fill } = setup(
    vi.fn(async (id) => (id === 'newest' ? ('retry' as const) : ('done' as const))),
  )
  runner.update(catalog, false, null)
  await vi.runAllTimersAsync()
  expect(fill.mock.calls.map(([id]) => id)).toEqual(['newest', 'newest', 'older', 'oldest'])
  runner.stop()
})
it('catalog removal cancels an obsolete download and disposal cannot restart it', async () => {
  const fill = vi.fn(
    (_id: string, signal: AbortSignal) =>
      new Promise<'done'>((resolve) => signal.addEventListener('abort', () => resolve('done'))),
  )
  const { runner } = setup(fill)
  runner.update(catalog, false, null)
  await tick()
  runner.update(catalog.slice(1), false, null)
  expect(fill.mock.calls[0][1].aborted).toBe(true)
  await tick()
  expect(fill.mock.calls[1][0]).toBe('older')
  runner.stop()
  runner.activity()
  await vi.runAllTimersAsync()
  expect(fill).toHaveBeenCalledTimes(2)
})

it('lock contention defers without exhausting network retries', async () => {
  const fill = vi.fn(
    async (): Promise<'done' | 'defer'> => (fill.mock.calls.length <= 3 ? 'defer' : 'done'),
  )
  const { runner } = setup(fill)
  runner.update(catalog.slice(0, 1), false, null)
  await vi.runAllTimersAsync()
  expect(fill).toHaveBeenCalledTimes(4)
  runner.stop()
})
