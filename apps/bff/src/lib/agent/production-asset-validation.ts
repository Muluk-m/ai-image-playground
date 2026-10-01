import {
  PRODUCTION_ASSETS_MAX,
  type ProductionContent,
  type ProductionMediaReference,
} from '@image-playground/shared'

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function identity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
}
export function validateProductionMediaReference(
  value: unknown,
): value is ProductionMediaReference {
  if (!object(value)) return false
  return value.kind === 'media'
    ? identity(value.mediaId)
    : value.kind === 'artifact'
      ? identity(value.artifactId)
      : value.kind === 'asset' && identity(value.imageId)
}
function entity(value: unknown): value is Record<string, unknown> {
  return (
    object(value) &&
    identity(value.id) &&
    typeof value.name === 'string' &&
    value.name.length <= 200 &&
    typeof value.description === 'string' &&
    value.description.length <= 10000
  )
}
export function validateProductionAssets(value: Partial<ProductionContent>): boolean {
  const identities = new Set<string>()
  function unique(one: Record<string, unknown>) {
    const id = String(one.id)
    if (identities.has(id)) return false
    identities.add(id)
    return true
  }
  const locations = value.locations ?? []
  const characters = value.characters ?? []
  if (
    !Array.isArray(locations) ||
    !Array.isArray(characters) ||
    locations.length > PRODUCTION_ASSETS_MAX ||
    characters.length > PRODUCTION_ASSETS_MAX
  )
    return false
  return (
    locations.every(
      (location: unknown) =>
        entity(location) &&
        unique(location) &&
        (location.reference === undefined || validateProductionMediaReference(location.reference)),
    ) &&
    characters.every(
      (character: unknown) =>
        entity(character) &&
        unique(character) &&
        Array.isArray(character.looks) &&
        character.looks.length <= PRODUCTION_ASSETS_MAX &&
        character.looks.every(
          (look: unknown) =>
            entity(look) &&
            unique(look) &&
            (look.reference === undefined || validateProductionMediaReference(look.reference)),
        ),
    )
  )
}
export function productionMediaReferences(content: ProductionContent): ProductionMediaReference[] {
  return [
    ...(content.shots ?? []).flatMap((shot) => (shot.keyframe ? [shot.keyframe] : [])),
    ...(content.locations ?? []).flatMap((location) =>
      location.reference ? [location.reference] : [],
    ),
    ...(content.characters ?? []).flatMap((character) =>
      character.looks.flatMap((look) => (look.reference ? [look.reference] : [])),
    ),
  ]
}
export function productionReferenceId(reference: ProductionMediaReference): string {
  return reference.kind === 'media'
    ? reference.mediaId
    : reference.kind === 'artifact'
      ? reference.artifactId
      : reference.imageId
}
export function productionReferenceKey(reference: ProductionMediaReference): string {
  return `${reference.kind}:${productionReferenceId(reference)}`
}
