import type { ProductionMediaReference } from './production'

/** 有序数组决定顺序，镜头身份不随排序或标题改变。 */
export interface ProductionShot {
  readonly dependencies?: readonly import('./production-dependencies').ProductionDependency[]
  readonly id: string
  readonly scriptSceneId?: string
  readonly locationId?: string
  readonly lookIds: readonly string[]
  readonly description: string
  readonly dialogue?: string
  readonly camera?: string
  readonly durationSeconds?: number
  readonly keyframe?: ProductionMediaReference
}
export interface ProductionStoryboardProposal {
  readonly id: string
  readonly baseRevision: number
  readonly shots: readonly ProductionShot[]
  readonly sourceTurnId: string
  readonly status: 'pending' | 'adopted' | 'discarded'
  readonly adoptedRevision?: number
  readonly createdAt: number
}
export const PRODUCTION_SHOTS_MAX = 200

export function isProductionShots(value: unknown): value is readonly ProductionShot[] {
  if (!Array.isArray(value) || value.length > PRODUCTION_SHOTS_MAX) return false
  const id = (one: unknown) => typeof one === 'string' && one.length > 0 && one.length <= 128
  const text = (one: unknown) =>
    one === undefined || (typeof one === 'string' && one.length <= 10000)
  return (
    new Set(value.map((shot) => shot?.id)).size === value.length &&
    value.every(
      (shot) =>
        shot &&
        id(shot.id) &&
        (shot.scriptSceneId === undefined || id(shot.scriptSceneId)) &&
        (shot.locationId === undefined || id(shot.locationId)) &&
        Array.isArray(shot.lookIds) &&
        shot.lookIds.length <= 30 &&
        shot.lookIds.every(id) &&
        typeof shot.description === 'string' &&
        shot.description.length <= 10000 &&
        text(shot.dialogue) &&
        text(shot.camera) &&
        (shot.durationSeconds === undefined ||
          (typeof shot.durationSeconds === 'number' &&
            Number.isFinite(shot.durationSeconds) &&
            shot.durationSeconds > 0)) &&
        (shot.keyframe === undefined ||
          (shot.keyframe &&
            ((shot.keyframe.kind === 'media' && id(shot.keyframe.mediaId)) ||
              (shot.keyframe.kind === 'artifact' && id(shot.keyframe.artifactId)) ||
              (shot.keyframe.kind === 'asset' && id(shot.keyframe.imageId))))),
    )
  )
}
