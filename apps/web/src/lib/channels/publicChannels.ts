/**
 * 提供给 UI / dispatch 层的内置 channel 读取入口。
 *
 * 真源：boot 时 `loadRuntimeConfig()` + `fetchDiscoveredChannels()` 把 BFF
 * 暴露的 channel 列表写进 `channelStore`；本文件在其之上给出**图片工作台视图**：
 * 只留 media 为 image 的模型。视频侧不经过这里，直接读 `channelStore`
 * （见 `videoChannels.ts`）—— 混进来的视频模型会被当成生图模型提交。
 *
 * 没有 BFF（runtimeConfig.bff.enabled=false）或 BFF 不可达时 store 为空数组，
 * 前端自动只剩 BYOK profile，UI 不渲染「内置」分组。
 */
import type { DiscoveredChannel } from '@image-playground/shared'
import { getStoredChannels } from './channelStore'
import type { PublicChannel } from './types'

let source: DiscoveredChannel[] | null = null
let imageChannels: PublicChannel[] = []
let imageById = new Map<string, PublicChannel>()

// 按来源数组身份缓存：返回引用必须稳定，normalizeSettings 的缓存拿它当失效键。
function view(): PublicChannel[] {
  const stored = getStoredChannels()
  if (stored !== source) {
    source = stored
    imageChannels = stored.map((c) => ({
      ...c,
      models: c.models.filter((m) => (m.media ?? 'image') === 'image'),
    }))
    imageById = new Map(imageChannels.map((c) => [c.id, c]))
  }
  return imageChannels
}

export function getPublicChannels(): PublicChannel[] {
  return view()
}

export function getPublicChannel(id: string): PublicChannel | undefined {
  view()
  return imageById.get(id)
}
