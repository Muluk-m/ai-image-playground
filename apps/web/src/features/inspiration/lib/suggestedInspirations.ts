import type { InspirationItem } from '../types'

/** A prompt-only shortcut must not silently depend on downloaded reference images or a skill. */
export function suggestedInspirations(
  items: readonly InspirationItem[],
  random = Math.random,
): InspirationItem[] {
  const pool = items.filter(
    (item) =>
      item.kind !== 'skill' &&
      !item.referenceImages?.length &&
      item.prompt.trim() &&
      item.thumbnailUrl,
  )
  for (let end = pool.length - 1; end > 0; end--) {
    const at = Math.floor(random() * (end + 1))
    ;[pool[end], pool[at]] = [pool[at]!, pool[end]!]
  }
  return pool.slice(0, 3)
}
