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

/** 上游只需回一个 200 JSON body；transport 细节由 lib/upstream 的注入点接管。 */
export function upstreamReturning(payload: unknown): TestFetch {
  return mock(
    async () => new Response(JSON.stringify(payload), { status: 200 }),
  ) as unknown as TestFetch
}

/** 换掉 globalThis.fetch，返回还原函数。归档回源取图走的是它，不是 upstream 注入点。 */
export function stubGlobalFetch(handler: () => Response | Promise<Response>): () => void {
  const real = globalThis.fetch
  globalThis.fetch = handler as unknown as typeof fetch
  return () => {
    globalThis.fetch = real
  }
}

/** 断言这条路径不该发起任何网络请求。 */
export function forbidGlobalFetch(): () => void {
  return stubGlobalFetch(() => {
    throw new Error('unexpected network fetch')
  })
}
