import { createHash } from 'node:crypto'
import type {
  ProductionClipPlan,
  ProductionContent,
  ProductionDependency,
  ProductionDependencyChange,
  ProductionShot,
} from '@image-playground/shared'

/** JSONB key order and display ordering must not make unchanged sources appear stale. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, one]) => one !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, one]) => `${JSON.stringify(key)}:${canonical(one)}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}
function resolveDependency(
  content: ProductionContent,
  kind: ProductionDependency['kind'],
  id: string,
): { name: string; value: unknown } | null {
  if (kind === 'scene') {
    const scene = content.scenes.find((one) => one.id === id)
    return scene ? { name: scene.title, value: scene } : null
  }
  if (kind === 'location') {
    const location = content.locations?.find((one) => one.id === id)
    return location ? { name: location.name, value: location } : null
  }
  if (kind === 'look') {
    for (const character of content.characters ?? []) {
      const look = character.looks.find((one) => one.id === id)
      if (look)
        return {
          name: `${character.name} · ${look.name}`,
          value: {
            characterId: character.id,
            characterName: character.name,
            characterDescription: character.description,
            look,
          },
        }
    }
    return null
  }
  const shot = content.shots?.find((one) => one.id === id)
  if (!shot) return null
  const { dependencies: _dependencies, ...value } = shot
  return { name: shot.description.slice(0, 80), value }
}
function snapshot(
  content: ProductionContent,
  kind: ProductionDependency['kind'],
  id: string,
  previous?: readonly ProductionDependency[],
): ProductionDependency {
  const resolved = resolveDependency(content, kind, id)
  if (resolved) return { kind, id, name: resolved.name, fingerprint: fingerprint(resolved.value) }
  const missing = previous?.find((one) => one.kind === kind && one.id === id)
  return missing ?? { kind, id, name: id, fingerprint: fingerprint(null) }
}
function unique(dependencies: readonly ProductionDependency[]): ProductionDependency[] {
  return [...new Map(dependencies.map((one) => [`${one.kind}:${one.id}`, one])).values()]
}
export function productionShotDependencies(
  content: ProductionContent,
  shot: ProductionShot,
  previous?: readonly ProductionDependency[],
): ProductionDependency[] {
  return unique([
    ...(shot.scriptSceneId ? [snapshot(content, 'scene', shot.scriptSceneId, previous)] : []),
    ...(shot.locationId ? [snapshot(content, 'location', shot.locationId, previous)] : []),
    ...shot.lookIds.map((id) => snapshot(content, 'look', id, previous)),
  ])
}
export function productionClipDependencies(
  content: ProductionContent,
  shotIds: readonly string[],
  previous?: readonly ProductionDependency[],
): ProductionDependency[] {
  return unique(
    shotIds.flatMap((id) => {
      const shot = content.shots?.find((one) => one.id === id)
      return [
        snapshot(content, 'shot', id, previous),
        ...(shot ? productionShotDependencies(content, shot, previous) : []),
      ]
    }),
  )
}
export function productionDependencyChanges(
  content: ProductionContent,
  dependencies: readonly ProductionDependency[],
): ProductionDependencyChange[] {
  return dependencies.flatMap((dependency) => {
    const current = resolveDependency(content, dependency.kind, dependency.id)
    return !current || fingerprint(current.value) !== dependency.fingerprint
      ? [
          {
            kind: dependency.kind,
            id: dependency.id,
            name: current?.name ?? dependency.name,
            missing: !current,
          },
        ]
      : []
  })
}

export type ProductionRefreshTarget = { kind: 'shot' | 'clip'; id: string }

function shotValue(shot: ProductionShot): unknown {
  const { dependencies: _dependencies, ...value } = shot
  return value
}
function clipValue(clip: ProductionClipPlan): unknown {
  const {
    dependencies: _dependencies,
    adopted: _adopted,
    sourceRevision: _sourceRevision,
    ...value
  } = clip
  return value
}
export function normalizeProductionDependencies(
  previous: ProductionContent | null,
  next: ProductionContent,
  refresh?: ProductionRefreshTarget,
  sourceRevision = 0,
): ProductionContent {
  const content = {
    ...next,
    ...(next.shots
      ? {
          shots: next.shots.map((shot) => {
            const old = previous?.shots?.find((one) => one.id === shot.id)
            const unchanged = old && canonical(shotValue(old)) === canonical(shotValue(shot))
            const dependencies =
              unchanged && !(refresh?.kind === 'shot' && refresh.id === shot.id)
                ? (old.dependencies ?? productionShotDependencies(previous!, old))
                : productionShotDependencies(next, shot, old?.dependencies)
            return { ...shot, dependencies }
          }),
        }
      : {}),
  }
  return {
    ...content,
    ...(next.clips
      ? {
          clips: next.clips.map((clip) => {
            const old = previous?.clips?.find((one) => one.id === clip.id)
            const unchanged =
              old &&
              canonical(clipValue(old)) === canonical(clipValue(clip)) &&
              !(refresh?.kind === 'clip' && refresh.id === clip.id)
            const dependencies = unchanged
              ? (old.dependencies ?? productionClipDependencies(previous!, old.shotIds))
              : productionClipDependencies(content, clip.shotIds, old?.dependencies)
            return {
              ...clip,
              sourceRevision: unchanged ? old.sourceRevision : sourceRevision,
              dependencies,
            }
          }),
        }
      : {}),
  }
}
export function productionDependencyStates(content: ProductionContent) {
  return {
    shotDependencyStates: (content.shots ?? []).map((shot) => {
      const changed = productionDependencyChanges(
        content,
        shot.dependencies ?? productionShotDependencies(content, shot),
      )
      return { shotId: shot.id, outdated: changed.length > 0, changed }
    }),
    dependencyStates: (content.clips ?? []).map((clip) => {
      const changed = productionDependencyChanges(
        content,
        clip.dependencies ?? productionClipDependencies(content, clip.shotIds),
      )
      return { clipId: clip.id, outdated: changed.length > 0, changed }
    }),
  }
}
