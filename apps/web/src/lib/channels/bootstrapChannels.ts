import type { DiscoveredChannel } from '@image-playground/shared'
import {
  channelsSettled,
  channelsSettledAt,
  getStoredChannels,
  markChannelsFresh,
  setChannels,
} from './channelStore'
import { fetchDiscoveredChannels } from './discoverChannels'

const DISCOVERY_TIMEOUT_MS = 15000
const RETRY_BASE_MS = 1000
const RETRY_MAX_MS = 15000
/** 运营停用/恢复模型后，后端最多 30 秒内照新单价表回答；页面隔这么久才再问一次。 */
export const CHANNEL_REFRESH_INTERVAL_MS = 30_000

let latestRequestId = 0
let retryAttempt = 0
let retryTimer: ReturnType<typeof setTimeout> | undefined
let preloaded: { baseUrl: string; promise: Promise<DiscoveredChannel[]> } | undefined
let catalogLoad: Promise<boolean> | undefined
let catalogLoadToken = 0
let refreshing: Promise<void> | undefined
/** 最近一次启动发现用的 BFF 地址；BFF 关着时是 undefined，那时没有可刷新的清单。 */
let liveBaseUrl: string | undefined

export function resetChannelDiscoveryForTests(): void {
  latestRequestId += 1
  catalogLoadToken += 1
  catalogLoad = undefined
  retryAttempt = 0
  if (retryTimer !== undefined) {
    clearTimeout(retryTimer)
    retryTimer = undefined
  }
  preloaded = undefined
  refreshing = undefined
  liveBaseUrl = undefined
}

function clearRetry(): void {
  if (retryTimer !== undefined) {
    clearTimeout(retryTimer)
    retryTimer = undefined
  }
}

function publish(requestId: number, channels: DiscoveredChannel[]): void {
  if (requestId !== latestRequestId) return
  clearRetry()
  retryAttempt = 0
  setChannels(channels)
}

function scheduleRetry(baseUrl: string, requestId: number): void {
  if (requestId !== latestRequestId || channelsSettled()) return
  clearRetry()
  const delay = Math.min(RETRY_BASE_MS * 2 ** retryAttempt, RETRY_MAX_MS)
  retryAttempt += 1
  retryTimer = setTimeout(() => {
    retryTimer = undefined
    if (requestId !== latestRequestId || channelsSettled()) return
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS)
    void fetchDiscoveredChannels(baseUrl, { signal: controller.signal })
      .then((channels) => {
        publish(requestId, channels)
      })
      .catch((err: unknown) => {
        if (requestId !== latestRequestId) return
        console.warn(
          '[channel-discovery] BFF unreachable; retrying.',
          err instanceof Error ? err.message : err,
        )
        scheduleRetry(baseUrl, requestId)
      })
      .finally(() => clearTimeout(timeout))
  }, delay)
}

/** Start public discovery alongside capabilities; AuthGate consumes the same response. */
export function preloadChannels(bffEnabled: boolean, bffBaseUrl: string): void {
  const requestId = ++latestRequestId
  clearRetry()
  retryAttempt = 0
  preloaded = undefined
  liveBaseUrl = bffEnabled ? bffBaseUrl : undefined
  if (!bffEnabled) {
    publish(requestId, [])
    return
  }
  const controller = new AbortController()
  const timeout = globalThis.setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS)
  const promise = fetchDiscoveredChannels(bffBaseUrl, { signal: controller.signal })
    .then((channels) => {
      publish(requestId, channels)
      return channels
    })
    .catch((err: unknown) => {
      if (requestId === latestRequestId) {
        console.warn(
          '[channel-discovery] BFF unreachable; retrying.',
          err instanceof Error ? err.message : err,
        )
        scheduleRetry(bffBaseUrl, requestId)
      }
      throw err
    })
    .finally(() => {
      globalThis.clearTimeout(timeout)
    })
  // A failed preload retries in the background. Callers that require the catalog
  // still see the rejection and can start their own attempt.
  void promise.catch(() => {})
  preloaded = { baseUrl: bffBaseUrl, promise }
}

export async function bootstrapChannels(
  bffEnabled: boolean,
  bffBaseUrl: string,
  required = false,
  signal?: AbortSignal,
): Promise<void> {
  const requestId = ++latestRequestId
  clearRetry()
  retryAttempt = 0
  liveBaseUrl = bffEnabled ? bffBaseUrl : undefined
  if (!bffEnabled) {
    publish(requestId, [])
    return
  }
  const controller = new AbortController()
  const timeout = globalThis.setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS)
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) controller.abort()
  try {
    const startup = preloaded?.baseUrl === bffBaseUrl ? preloaded : undefined
    const channels = startup
      ? await startup.promise
      : await fetchDiscoveredChannels(bffBaseUrl, { signal: controller.signal })
    if (requestId === latestRequestId && !signal?.aborted) publish(requestId, channels)
  } catch (err) {
    if (preloaded?.baseUrl === bffBaseUrl) preloaded = undefined
    if (signal?.aborted || requestId !== latestRequestId) return
    console.warn(
      '[channel-discovery] BFF unreachable; no platform channels are available yet.',
      err instanceof Error ? err.message : err,
    )
    if (required) throw err
    scheduleRetry(bffBaseUrl, requestId)
  } finally {
    globalThis.clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}

async function loadCatalog(): Promise<boolean> {
  const { getRuntimeConfig } = await import('../runtimeConfig')
  const runtime = getRuntimeConfig()
  if (!runtime.bff.enabled) {
    setChannels([])
    return true
  }
  try {
    await bootstrapChannels(runtime.bff.enabled, runtime.bff.baseUrl, false)
  } catch {
    // required=false 时失败已经安排了后台重试，这里不把异常再抛出去。
  }
  return channelsSettled()
}

/**
 * 等当前这一次渠道清单。已经加载完就立刻返回。
 * 还在加载时，所有调用方共用同一个 promise：后一次不能把先返回的结果作废。
 * 这一次失败也不把清单标成空；promise 清掉后，下一次调用或后台重试可以再要。
 */
export function ensureChannelsLoaded(): Promise<boolean> {
  if (channelsSettled()) return Promise.resolve(true)
  if (!catalogLoad) {
    const token = ++catalogLoadToken
    const run = loadCatalog().finally(() => {
      if (token === catalogLoadToken) catalogLoad = undefined
    })
    catalogLoad = run
  }
  return catalogLoad
}

/**
 * 已经拿到清单之后再问一次：页面开着时运营停用或恢复了模型，否则这个标签页会一直按打开那一刻的清单报价，
 * 画布节点拦在「模型不可用」上（或者明明已停用还照样提交）。距上次拿到清单不到
 * {@link CHANNEL_REFRESH_INTERVAL_MS} 就不问；还没拿到清单时交给启动那一路与它的重试。
 * 失败时保留现有清单，不把它清空。
 */
export function refreshChannels(now = Date.now()): Promise<void> {
  if (refreshing) return refreshing
  const baseUrl = liveBaseUrl
  if (
    baseUrl === undefined ||
    !channelsSettled() ||
    now - channelsSettledAt() < CHANNEL_REFRESH_INTERVAL_MS
  )
    return Promise.resolve()
  const requestId = latestRequestId
  const run = (async () => {
    const controller = new AbortController()
    const timeout = globalThis.setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS)
    try {
      const channels = await fetchDiscoveredChannels(baseUrl, {
        signal: controller.signal,
      })
      if (requestId !== latestRequestId) return
      // 没变就不广播：订阅者（画布报价、模型下拉）不用白白重算。
      if (JSON.stringify(channels) === JSON.stringify(getStoredChannels())) {
        markChannelsFresh()
        return
      }
      publish(requestId, channels)
    } catch {
      // 保留现有清单：一次没拿到不代表模型都没了。
    } finally {
      globalThis.clearTimeout(timeout)
    }
  })()
  const tracked: Promise<void> = run.finally(() => {
    if (refreshing === tracked) refreshing = undefined
  })
  refreshing = tracked
  return tracked
}

/** 标签页回到前台时刷新一次清单。返回卸载函数。 */
export function refreshChannelsWhenVisible(target: Window = window): () => void {
  const refresh = () => {
    if (target.document.visibilityState !== 'hidden') void refreshChannels()
  }
  target.addEventListener('focus', refresh)
  target.document.addEventListener('visibilitychange', refresh)
  return () => {
    target.removeEventListener('focus', refresh)
    target.document.removeEventListener('visibilitychange', refresh)
  }
}
