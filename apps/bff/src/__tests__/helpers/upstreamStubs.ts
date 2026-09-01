import { mock } from 'bun:test'
import type { setUpstreamFetchForTesting } from '../../lib/upstream'

type TestFetch = NonNullable<Parameters<typeof setUpstreamFetchForTesting>[0]>

/** Upstream that never answers on its own, so a test decides when and how the request aborts. */
export function abortableUpstreamFetch(): TestFetch {
  return mock(async (_input, init) => {
    return new Promise((_resolve, reject) => {
      const signal = (init as { signal?: AbortSignal } | undefined)?.signal
      const rejectAbort = () => reject(new DOMException('Aborted', 'AbortError'))
      if (signal?.aborted) return rejectAbort()
      signal?.addEventListener('abort', rejectAbort, { once: true })
    })
  }) as unknown as TestFetch
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('condition timed out')
    await Bun.sleep(5)
  }
}
