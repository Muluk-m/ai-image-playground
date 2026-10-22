/**
 * 提供给 UI / dispatch 层的内置 channel 读取入口。
 *
 * 真源：boot 时 `loadRuntimeConfig()` + `fetchDiscoveredChannels()` 把 BFF
 * 暴露的 channel 列表写进 `channelStore`；本文件在其之上给出**图片工作台视图**：
 * 只留 media 为 image 的模型。视频侧不经过这里，直接读 `channelStore`
 * （见 `videoChannels.ts`）—— 混进来的视频模型会被当成生图模型提交。
 *
 * 没有 BFF（runtimeConfig.bff.enabled=false）时 store 是一份已确认的空清单。
 * BFF 暂时不可达时清单还没落地（空数组只是初始值），生成会等重试，而不是报渠道缺失。
 */
import { type DiscoveredChannel, MODEL_LOGOS, type ModelLogoId } from '@image-playground/shared'
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

/**
 * 展示用的模型名。内置模型用渠道下发的 label；同一 id 出现在多条渠道上时，
 * 先认任务记下的 profile（内置 profile 的 id 就是 channel id）。
 * 认不出的（清单还没到、或已下线的旧模型）退回 id，不另造一个名字。
 */
export function modelLabel(modelId: string, channelId?: string): string {
  if (!modelId) return ''
  const channels = getPublicChannels()
  const preferred = channelId ? channels.find((channel) => channel.id === channelId) : undefined
  const fromPreferred = preferred?.models.find((model) => model.id === modelId)?.label
  if (fromPreferred) return fromPreferred
  for (const channel of channels) {
    const label = channel.models.find((model) => model.id === modelId)?.label
    if (label) return label
  }
  return modelId
}

interface LogoIndex {
  /** `${channelId}\u0000${modelId}` → 该渠道给这个模型声明的图标。 */
  byChannel: Map<string, ModelLogoId>
  /** 不知道渠道时用：modelId → 第一条声明了图标的渠道里的图标。 */
  byModel: Map<string, ModelLogoId>
  channelIds: Set<string>
}

// 按清单数组身份缓存：清单不变时每个 `ModelLogo` 只做一次 Map 查找。
const logoIndex = new WeakMap<readonly DiscoveredChannel[], LogoIndex>()

function indexLogos(channels: readonly DiscoveredChannel[]): LogoIndex {
  const cached = logoIndex.get(channels)
  if (cached) return cached
  const index: LogoIndex = { byChannel: new Map(), byModel: new Map(), channelIds: new Set() }
  for (const channel of channels) {
    index.channelIds.add(channel.id)
    for (const model of channel.models) {
      // 只认前端打包了图标文件的 token；不认识的（新版 BFF、旧标签页）退回厂商图标。
      if (!MODEL_LOGOS.includes(model.logo as ModelLogoId)) continue
      const logo = model.logo as ModelLogoId
      index.byChannel.set(`${channel.id}\u0000${model.id}`, logo)
      if (!index.byModel.has(model.id)) index.byModel.set(model.id, logo)
    }
  }
  logoIndex.set(channels, index)
  return index
}

/**
 * 模型在渠道配置里声明的品牌图标（`ChannelModel.logo`）。图片、视频模型都认，所以直接读
 * channelStore 而不是图片视图。知道模型来自哪条渠道时传 `channelId`，只认那条渠道的声明——
 * 同一 id 在不同渠道可能是不同品牌；不知道渠道（历史任务等）时取第一条声明了图标的渠道。
 * 没声明（或清单还没到）返回 undefined，调用方按 id 前缀给厂商图标。组件里要传订阅到的快照，
 * 清单晚到时才会跟着重渲染（见 `ModelLogo`）。
 */
export function modelLogo(
  modelId: string,
  channels: readonly DiscoveredChannel[] = getStoredChannels(),
  channelId?: string,
): ModelLogoId | undefined {
  if (!modelId) return undefined
  const index = indexLogos(channels)
  if (channelId && index.channelIds.has(channelId))
    return index.byChannel.get(`${channelId}\u0000${modelId}`)
  return index.byModel.get(modelId)
}
