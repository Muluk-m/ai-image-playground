import type { InspirationItem } from '../types'

const PREVIOUS_BATCH_KEY = 'inspiration-hero-previous:v1'
export const HERO_CARD_COUNT = 6

export function selectHeroItems(
  items: readonly InspirationItem[],
  previousIds: readonly string[] = [],
): InspirationItem[] {
  const previous = new Set(previousIds)
  const unique = [...new Map(items.map((item) => [item.id, item])).values()]
  const unseen = unique.filter((item) => !previous.has(item.id))
  const pool = unseen.length >= HERO_CARD_COUNT ? unseen : unique
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j]!, pool[i]!]
  }
  const categories = new Set<string>()
  const selected: InspirationItem[] = []
  for (const item of pool) {
    if (categories.has(item.category)) continue
    categories.add(item.category)
    selected.push(item)
    if (selected.length === HERO_CARD_COUNT) return selected
  }
  for (const item of pool) {
    if (!selected.includes(item)) selected.push(item)
    if (selected.length === HERO_CARD_COUNT) break
  }
  return selected
}

/** 只保留上批 ID；存储不可用时仍可随机展示。 */
export function rotateHeroItems(items: readonly InspirationItem[]): InspirationItem[] {
  let previous: string[] = []
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(PREVIOUS_BATCH_KEY) ?? '[]')
    if (Array.isArray(stored))
      previous = stored.filter((id): id is string => typeof id === 'string')
  } catch {}
  const selected = selectHeroItems(items, previous)
  try {
    sessionStorage.setItem(PREVIOUS_BATCH_KEY, JSON.stringify(selected.map((item) => item.id)))
  } catch {}
  return selected
}
