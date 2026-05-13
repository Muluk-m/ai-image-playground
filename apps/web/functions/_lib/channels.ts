import channelsConfig from '../../config/channels.json'
import type { ChannelConfig, ChannelsConfig } from './types'

const config = channelsConfig as ChannelsConfig

export function findChannel(channelId: string): ChannelConfig | undefined {
  return config.channels.find((c) => c.id === channelId)
}
