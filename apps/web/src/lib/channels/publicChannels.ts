import publicChannelsJson from '../../generated/channels.public.json'
import type { PublicChannel } from './types'
import { QUEUE_CHANNELS } from './queueChannels'

const RAW: { channels: PublicChannel[] } = publicChannelsJson as { channels: PublicChannel[] }

// 测试模式下不加载真实 channel，避免污染单测期望（注入 builtin-edge profile 等）。
// 测试需要构造特定 channel 时，通过 vi.mock('./publicChannels', ...) 覆写。
const IS_TEST = import.meta.env.MODE === 'test'

const builtinVisible: PublicChannel[] = IS_TEST ? [] : RAW.channels.filter((c) => c.disabled !== true)
const visibleChannels: PublicChannel[] = [...builtinVisible, ...QUEUE_CHANNELS]
const channelsById = new Map(visibleChannels.map((c) => [c.id, c]))

export function getPublicChannels(): PublicChannel[] {
  return visibleChannels
}

export function getPublicChannel(id: string): PublicChannel | undefined {
  return channelsById.get(id)
}
