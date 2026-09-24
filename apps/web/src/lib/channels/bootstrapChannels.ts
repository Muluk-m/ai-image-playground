import { setChannels } from './channelStore'
import { fetchDiscoveredChannels } from './discoverChannels'

const DISCOVERY_TIMEOUT_MS = 15000
let latestRequestId = 0

export async function bootstrapChannels(
  bffEnabled: boolean,
  bffBaseUrl: string,
  required = false,
  signal?: AbortSignal,
): Promise<void> {
  const requestId = ++latestRequestId
  setChannels([])
  if (!bffEnabled) return
  const controller = new AbortController()
  const timeout = globalThis.setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS)
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) controller.abort()
  try {
    const channels = await fetchDiscoveredChannels(bffBaseUrl, {
      signal: controller.signal,
    })
    if (requestId === latestRequestId && !signal?.aborted) setChannels(channels)
  } catch (err) {
    if (signal?.aborted) return
    if (required) throw err
    console.warn(
      '[channel-discovery] BFF unreachable; UI will only offer BYOK profiles.',
      err instanceof Error ? err.message : err,
    )
  } finally {
    globalThis.clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}
