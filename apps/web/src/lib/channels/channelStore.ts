/**
 * 客户端 channel store。`discoverChannels` 拉到的 channel 列表写进来；
 * `getPublicChannels()` / `getPublicChannel(id)` 都直接读这份内存状态。
 *
 * `settled` 区分「还在加载 / 上次失败、正在重试」和「已经拿到一份清单」。
 * 失败时不能把空数组当成加载完成，否则设置会被正规化成没有渠道。
 */
import type { DiscoveredChannel } from '@image-playground/shared'

let channels: DiscoveredChannel[] = []
let settled = false
let settledAt = 0
let byId = new Map<string, DiscoveredChannel>()
const listeners = new Set<() => void>()

export function setChannels(list: DiscoveredChannel[]): void {
  channels = list
  settled = true
  settledAt = Date.now()
  byId = new Map(list.map((c) => [c.id, c]))
  for (const listener of listeners) listener()
}

/** 清单还没成功到达。空数组在这之前不代表「这个部署没有渠道」。 */
export function channelsSettled(): boolean {
  return settled
}

/** 最近一次拿到清单的时刻（毫秒）；还没拿到时是 0。 */
export function channelsSettledAt(): number {
  return settledAt
}

/** 再问了一次、清单没变：记下时刻，不广播。 */
export function markChannelsFresh(): void {
  if (settled) settledAt = Date.now()
}

/** 测试用：回到「还没加载」而不是「已确认没有渠道」。 */
export function resetChannelCatalog(): void {
  channels = []
  settled = false
  settledAt = 0
  byId = new Map()
  for (const listener of listeners) listener()
}

export function subscribeChannels(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getStoredChannels(): DiscoveredChannel[] {
  return channels
}

export function getStoredChannel(id: string): DiscoveredChannel | undefined {
  return byId.get(id)
}
