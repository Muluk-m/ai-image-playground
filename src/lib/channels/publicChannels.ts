import publicChannelsJson from '../../generated/channels.public.json'
import type { PublicChannel } from './types'

const RAW: { channels: PublicChannel[] } = publicChannelsJson as { channels: PublicChannel[] }

const visibleChannels: PublicChannel[] = RAW.channels.filter((c) => c.disabled !== true)
const channelsById = new Map(visibleChannels.map((c) => [c.id, c]))

export function getPublicChannels(): PublicChannel[] {
  return visibleChannels
}

export function getPublicChannel(id: string): PublicChannel | undefined {
  return channelsById.get(id)
}
