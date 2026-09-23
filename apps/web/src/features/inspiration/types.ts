import type {
  InspirationItem as SharedInspirationItem,
  InspirationManifest as SharedInspirationManifest,
} from '@image-playground/shared'
import type { ProviderKind } from '../../lib/channels/types'

/**
 * 灵感库单条示例。
 *
 * - `id` 是稳定 key（远程 manifest 通过同 id 覆盖内置）
 * - `recommendedProvider` + `recommendedModel` 用于「应用」时定位 ClientProfile
 * - `params` 仅覆盖 InputBar 用户可控字段；output_format / moderation 等不在此范围
 */
export interface InspirationItem extends Omit<SharedInspirationItem, 'recommendedProvider'> {
  recommendedProvider: ProviderKind
}

export interface InspirationManifest extends Omit<SharedInspirationManifest, 'items'> {
  items: InspirationItem[]
}
