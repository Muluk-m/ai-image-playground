import type { AgentConversationView } from '@image-playground/shared'
import { AUTH_SESSION_EXPIRED_EVENT } from '../../../lib/authClient'
import { scopedStorageName } from '../../../lib/authScope'
import { getRuntimeConfig } from '../../../lib/runtimeConfig'
import { AgentRequestError, fetchMessages } from './agentClient'
import { conversationCache } from './conversationCache'
import { prefetchPolicy } from './conversationCachePolicy'
import { panelStateFromHistory } from './panelMessages'

interface PrefetchDependencies {
  available(): boolean
  schedule(work: () => void, delay: number): () => void
  fill(id: string, signal: AbortSignal): Promise<'done' | 'stop' | 'retry' | 'defer'>
}

/** One cancellable download at a time, with a quiet interval before every item. */
export function createConversationPrefetch(deps: PrefetchDependencies) {
  let catalog: readonly AgentConversationView[] = []
  const completed = new Set<string>()
  const attempts = new Map<string, number>()
  let foreground = false
  let selected: string | null = null
  let active: AbortController | undefined
  let cancelScheduled: (() => void) | undefined
  let stopped = false

  const pause = () => {
    cancelScheduled?.()
    cancelScheduled = undefined
    active?.abort()
  }
  const schedule = (delay = prefetchPolicy.idleMs) => {
    if (stopped || foreground || active || cancelScheduled || !deps.available()) return
    if (!catalog.some((item) => item.id !== selected && !completed.has(item.id))) return
    cancelScheduled = deps.schedule(() => {
      cancelScheduled = undefined
      void run()
    }, delay)
  }
  const run = async () => {
    if (stopped || foreground || !deps.available()) return
    const item = catalog.find((one) => one.id !== selected && !completed.has(one.id))
    if (!item) return
    const controller = new AbortController()
    active = controller
    let delay = prefetchPolicy.idleMs
    try {
      const result = await deps.fill(item.id, controller.signal)
      if (controller.signal.aborted) return
      if (result === 'stop') stopped = true
      else if (result === 'done') completed.add(item.id)
      else if (result === 'defer') delay = prefetchPolicy.retryMs
      else throw new Error('Retry background history')
    } catch {
      if (!controller.signal.aborted) {
        const count = (attempts.get(item.id) ?? 0) + 1
        attempts.set(item.id, count)
        if (count >= prefetchPolicy.maxAttempts) completed.add(item.id)
        delay = prefetchPolicy.retryMs
      }
    } finally {
      active = undefined
      schedule(delay)
    }
  }
  return {
    update(
      conversations: readonly AgentConversationView[],
      busy: boolean,
      conversationId: string | null,
    ) {
      const changed =
        catalog !== conversations || foreground !== busy || selected !== conversationId
      catalog = conversations
      foreground = busy
      selected = conversationId
      if (changed) pause()
      schedule()
    },
    activity() {
      pause()
      schedule()
    },
    stop() {
      stopped = true
      pause()
    },
  }
}

type NetworkInformation = EventTarget & { saveData?: boolean; effectiveType?: string }

/** Lazily mounted after the authoritative catalog arrives; never gates the foreground store. */
export function browserConversationPrefetch() {
  const scope = scopedStorageName('agent-prefetch')
  const backend = getRuntimeConfig().bff.baseUrl
  const isCurrent = () =>
    scopedStorageName('agent-prefetch') === scope && getRuntimeConfig().bff.baseUrl === backend
  const network = (navigator as Navigator & { connection?: NetworkInformation }).connection
  const runner = createConversationPrefetch({
    available: () =>
      isCurrent() &&
      document.visibilityState === 'visible' &&
      navigator.onLine &&
      !network?.saveData &&
      !['slow-2g', '2g'].includes(network?.effectiveType ?? ''),
    schedule(work, delay) {
      let idle: number | undefined
      const timer = setTimeout(() => {
        if (window.requestIdleCallback) idle = window.requestIdleCallback(work)
        else work()
      }, delay)
      return () => {
        clearTimeout(timer)
        if (idle !== undefined) window.cancelIdleCallback(idle)
      }
    },
    async fill(id, signal) {
      const fill = async (): Promise<'done' | 'stop' | 'retry' | 'defer'> => {
        const cache = conversationCache(id)
        if (!isCurrent() || signal.aborted) return 'stop'
        const status = await cache.prefetchStatus()
        if (!isCurrent() || signal.aborted) return 'stop'
        if (status === 'present') return 'done'
        if (status !== 'missing') return 'stop'
        signal.throwIfAborted()
        try {
          const snapshot = await fetchMessages(id, undefined, signal)
          if (signal.aborted || !isCurrent()) return 'stop'
          const result = await cache.prefetch(panelStateFromHistory(snapshot), signal)
          return result === 'full' || result === 'unavailable' ? 'stop' : 'done'
        } catch (error) {
          if (error instanceof AgentRequestError) {
            if (error.status === 401) return 'stop'
            if (error.status === 403 || error.status === 404) return 'done'
          }
          throw error
        }
      }
      // Same-origin tabs share one background network slot. A busy leader is retried later.
      if (navigator.locks)
        return navigator.locks.request(`${scope}:${backend}`, { ifAvailable: true }, (lock) =>
          lock ? fill() : 'defer',
        )
      return fill()
    },
  })
  const activity = () => runner.activity()
  const stop = () => runner.stop()
  const events = [
    'pointerdown',
    'keydown',
    'input',
    'wheel',
    'touchstart',
    'online',
    'offline',
  ] as const
  for (const event of events)
    window.addEventListener(event, activity, { passive: true, capture: true })
  document.addEventListener('visibilitychange', activity)
  network?.addEventListener('change', activity)
  window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, stop)
  window.addEventListener('pagehide', activity)
  return {
    isCurrent,
    update: runner.update,
    dispose() {
      runner.stop()
      for (const event of events) window.removeEventListener(event, activity, true)
      document.removeEventListener('visibilitychange', activity)
      network?.removeEventListener('change', activity)
      window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, stop)
      window.removeEventListener('pagehide', activity)
    },
  }
}
