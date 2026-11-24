import type { ProductionShot } from '@image-playground/shared'
export function hasValidProductionShotReferences(
  content: import('@image-playground/shared').ProductionContent,
  shots: readonly ProductionShot[],
  previousShots: readonly ProductionShot[] = [],
): boolean {
  const lookIds = new Set(
    (content.characters ?? []).flatMap((character) => character.looks.map((look) => look.id)),
  )
  const locationIds = new Set((content.locations ?? []).map((location) => location.id))
  const sceneIds = new Set(content.scenes.map((scene) => scene.id))
  return !shots.some((shot) => {
    const previous = previousShots.find((item) => item.id === shot.id)
    return (
      shot.lookIds.some((id) => !lookIds.has(id) && !previous?.lookIds.includes(id)) ||
      (shot.locationId &&
        !locationIds.has(shot.locationId) &&
        previous?.locationId !== shot.locationId) ||
      (shot.scriptSceneId &&
        !sceneIds.has(shot.scriptSceneId) &&
        previous?.scriptSceneId !== shot.scriptSceneId)
    )
  })
}
