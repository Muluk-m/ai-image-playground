import type { DiscoveredChannel } from '@image-playground/shared'
import { channelsSettled, setChannels } from './channelStore'
import { fetchDiscoveredChannels } from './discoverChannels'

const DISCOVERY_TIMEOUT_MS = 15000
const RETRY_BASE_MS = 1000
const RETRY_MAX_MS = 15000

let latestRequestId = 0
let retryAttempt = 0
let retryTimer: ReturnType<typeof setTimeout> | undefined
let preloaded: { baseUrl: string; promise: Promise<DiscoveredChannel[]> } | undefined
let catalogLoad: Promise<boolean> | undefined
let catalogLoadToken = 0

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
