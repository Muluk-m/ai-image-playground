/**
 * 提供给 UI / dispatch 层的内置 channel 读取入口。
 *
 * 真源：boot 时 `loadRuntimeConfig()` + `fetchDiscoveredChannels()` 把 BFF
 * 暴露的 channel 列表写进 `channelStore`；本文件只是 thin wrapper，把存储里
 * 的列表按现有 `PublicChannel` 类型暴露出去。
 *
 * 没有 BFF（runtimeConfig.bff.enabled=false）或 BFF 不可达时 store 为空数组，
 * 前端自动只剩 BYOK profile，UI 不渲染「内置」分组。
 */
import { getStoredChannel, getStoredChannels } from './channelStore'
import type { PublicChannel } from './types'

export function getPublicChannels(): PublicChannel[] {
  return getStoredChannels()
}

export function getPublicChannel(id: string): PublicChannel | undefined {
  return getStoredChannel(id)
}
