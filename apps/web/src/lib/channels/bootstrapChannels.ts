import { setChannels } from './channelStore'
import { fetchDiscoveredChannels } from './discoverChannels'

const DISCOVERY_TIMEOUT_MS = 5000

export async function bootstrapChannels(
  bffEnabled: boolean,
  bffBaseUrl: string,
  required = false,
): Promise<void> {
  setChannels([])
  if (!bffEnabled) return
  try {
    const channels = await fetchDiscoveredChannels(bffBaseUrl, {
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    })
    setChannels(channels)
  } catch (err) {
    if (required) throw err
    console.warn(
      '[channel-discovery] BFF unreachable; UI will only offer BYOK profiles.',
      err instanceof Error ? err.message : err,
    )
  }
}
