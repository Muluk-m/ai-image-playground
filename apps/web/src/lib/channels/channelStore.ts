/**
 * 客户端 channel store。Boot 期间 `discoverChannels` 拉到的 channel 列表写进来；
 * 后续 `getPublicChannels()` / `getPublicChannel(id)` 都直接 hit 这份内存状态。
 *
 * 无响应式：runtime config 与 channel 列表在 boot 时一锤定音，UI 起来后不会变。
 * 切换需要刷新页面，跟「环境配置」语义一致。
 */
import type { DiscoveredChannel } from '@image-playground/shared'

let channels: DiscoveredChannel[] = []
let byId = new Map<string, DiscoveredChannel>()

export function setChannels(list: DiscoveredChannel[]): void {
  channels = list
  byId = new Map(list.map((c) => [c.id, c]))
}

export function getStoredChannels(): DiscoveredChannel[] {
  return channels
}

export function getStoredChannel(id: string): DiscoveredChannel | undefined {
  return byId.get(id)
}
