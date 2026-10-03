import {
  PRODUCTION_CLIPS_MAX,
  type ProductionClipPlan,
  type ProductionContent,
  productionClipVideo,
  videoPromptRejection,
  videoRequestRejection,
} from '@image-playground/shared'
import { validateProductionMediaReference } from './production-asset-validation'

function identity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
}
export function validateProductionClips(content: Partial<ProductionContent>): boolean {
  const clips = content.clips
  if (clips === undefined) return true
  if (!Array.isArray(clips) || clips.length > PRODUCTION_CLIPS_MAX) return false
  const ids = new Set<string>()
  return clips.every((value: unknown) => {
    if (!value || typeof value !== 'object') return false
    const clip = value as ProductionClipPlan
    if (
      !identity(clip.id) ||
      ids.has(clip.id) ||
      typeof clip.name !== 'string' ||
      clip.name.length > 200 ||
      typeof clip.prompt !== 'string' ||
      clip.prompt.length > 32000 ||
      typeof clip.model !== 'string' ||
      !clip.model ||
      clip.model.length > 200 ||
      !Number.isSafeInteger(clip.sourceRevision) ||
      clip.sourceRevision < 0 ||
      !Array.isArray(clip.shotIds) ||
      clip.shotIds.length === 0 ||
      clip.shotIds.length > 100 ||
      !clip.shotIds.every(identity) ||
      new Set(clip.shotIds).size !== clip.shotIds.length ||
      !Array.isArray(clip.references) ||
      clip.references.length > 16 ||
      !clip.references.every(
        (one) =>
          one &&
          validateProductionMediaReference(one.reference) &&
          ['first-frame', 'last-frame', 'reference'].includes(one.usage),
      )
    )
      return false
    ids.add(clip.id)
    if (
      clip.references.filter((one) => one.usage === 'first-frame').length > 1 ||
      clip.references.filter((one) => one.usage === 'last-frame').length > 1
    )
      return false
    if (
      !clip.video ||
      typeof clip.video !== 'object' ||
      (clip.video.mode && clip.video.mode !== 'generate')
    )
      return false
    if (
      clip.adopted &&
      (!identity(clip.adopted.draftId) ||
        !identity(clip.adopted.artifactId) ||
        !Number.isFinite(clip.adopted.adoptedAt))
    )
      return false
    return (
      videoRequestRejection(clip.model, productionClipVideo(clip), clip.references.length) ===
        null && videoPromptRejection(clip.model, clip.prompt) === null
    )
  })
}

export function hasValidProductionClipReferences(
  content: ProductionContent,
  previous: ProductionContent | undefined,
  allowAdoption: boolean,
): boolean {
  const available = new Set(
    ('shots' in content && Array.isArray(content.shots) ? content.shots : []).map(
      (shot) => shot.id,
    ),
  )
  return (content.clips ?? []).every((clip) => {
    const before = previous?.clips?.find((one) => one.id === clip.id)
    // JSONB and request normalization can reorder keys without changing the adopted result.
    if (
      !allowAdoption &&
      (clip.adopted?.draftId !== before?.adopted?.draftId ||
        clip.adopted?.artifactId !== before?.adopted?.artifactId ||
        clip.adopted?.adoptedAt !== before?.adopted?.adoptedAt)
    )
      return false
    return clip.shotIds.every((id) => available.has(id) || before?.shotIds.includes(id))
  })
}
