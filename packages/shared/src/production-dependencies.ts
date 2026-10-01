/** A compact snapshot of one explicit upstream dependency, never media bytes. */
export interface ProductionDependency {
  readonly kind: 'scene' | 'look' | 'location' | 'shot'
  readonly id: string
  readonly name: string
  readonly fingerprint: string
}
export interface ProductionDependencyChange {
  readonly kind: ProductionDependency['kind']
  readonly id: string
  readonly name: string
  readonly missing: boolean
}
export interface ProductionClipDependencyState {
  readonly clipId: string
  readonly outdated: boolean
  readonly changed: readonly ProductionDependencyChange[]
}
export interface ProductionShotDependencyState {
  readonly shotId: string
  readonly outdated: boolean
  readonly changed: readonly ProductionDependencyChange[]
}
export const PRODUCTION_DEPENDENCIES_MAX = 500

export interface ProductionDeleteImpact {
  readonly shotIds: readonly string[]
  readonly clipIds: readonly string[]
}
export function productionDeleteImpact(
  content: import('./production').ProductionContent,
  target: { kind: 'character' | 'look' | 'location' | 'scene' | 'shot'; id: string },
): ProductionDeleteImpact {
  const looks =
    target.kind === 'character'
      ? (content.characters
          ?.find((character) => character.id === target.id)
          ?.looks.map((look) => look.id) ?? [])
      : target.kind === 'look'
        ? [target.id]
        : []
  const shotIds = (content.shots ?? [])
    .filter((shot) =>
      target.kind === 'shot'
        ? shot.id === target.id
        : target.kind === 'location'
          ? shot.locationId === target.id
          : target.kind === 'scene'
            ? shot.scriptSceneId === target.id
            : shot.lookIds.some((id) => looks.includes(id)),
    )
    .map((shot) => shot.id)
  return {
    shotIds,
    clipIds: (content.clips ?? [])
      .filter((clip) => clip.shotIds.some((id) => shotIds.includes(id)))
      .map((clip) => clip.id),
  }
}
