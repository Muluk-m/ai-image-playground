import type { ProviderKind } from '../../lib/channels/types'

/**
 * 灵感库单条示例。
 *
 * - `id` 是稳定 key（远程 manifest 通过同 id 覆盖内置）
 * - `recommendedProvider` + `recommendedModel` 用于「应用」时定位 ClientProfile
 * - `params` 仅覆盖 InputBar 用户可控字段；output_format / moderation 等不在此范围
 */
export interface InspirationItem {
  id: string
  title: string
  description?: string
  prompt: string
  thumbnailUrl: string
  imageUrl?: string
  params: {
    size: string
    quality?: 'auto' | 'low' | 'medium' | 'high'
    n?: number
  }
  recommendedModel: string
  recommendedProvider: ProviderKind
  category: string
  tags?: string[]
  author?: string
  /** 原 prompt 出处链接（如推文 URL）；仅用于致谢展示，不参与逻辑 */
  sourceUrl?: string
}

export interface InspirationManifest {
  version: number
  updatedAt: string
  items: InspirationItem[]
  categories?: string[]
}
