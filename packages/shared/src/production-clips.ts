import type { ProductionMediaReference } from './production'
import type { VideoRequest } from './video-presets'

export interface ProductionClipReference {
  readonly reference: ProductionMediaReference
  readonly usage: 'first-frame' | 'last-frame' | 'reference'
}
export interface ProductionClipPlan {
  readonly id: string
  readonly name: string
  readonly shotIds: readonly string[]
  readonly prompt: string
  readonly model: string
  readonly video: VideoRequest
  readonly references: readonly ProductionClipReference[]
  readonly sourceRevision: number
  readonly adopted?: {
    readonly draftId: string
    readonly artifactId: string
    readonly adoptedAt: number
  }
}
export const PRODUCTION_CLIPS_MAX = 40

/** The reference order is frozen in the plan; model input indices derive from that same order. */
export function productionClipVideo(
  plan: Pick<ProductionClipPlan, 'video' | 'references'>,
): VideoRequest {
  const {
    first_frame_index: _first,
    last_frame_index: _last,
    reference_image_indices: _refs,
    ...video
  } = plan.video
  const first = plan.references.findIndex((one) => one.usage === 'first-frame')
  const last = plan.references.findIndex((one) => one.usage === 'last-frame')
  const references = plan.references.flatMap((one, index) =>
    one.usage === 'reference' ? [index] : [],
  )
  return {
    ...video,
    ...(first >= 0 ? { first_frame_index: first } : {}),
    ...(last >= 0 ? { last_frame_index: last } : {}),
    ...(references.length ? { reference_image_indices: references } : {}),
  }
}
