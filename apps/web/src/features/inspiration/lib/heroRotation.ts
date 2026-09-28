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
  const seen = unique.filter((item) => previous.has(item.id))
  for (const group of [unseen, seen]) {
    for (let i = group.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[group[i], group[j]] = [group[j]!, group[i]!]
    }
  }
  const categories = new Set<string>()
  const selected: InspirationItem[] = []
  const unseenNormal = unseen.filter((item) => !item.referenceImages?.length)
  const seenNormal = seen.filter((item) => !item.referenceImages?.length)
  // 普通卡不够六张时，复用上批对比卡来填满六列；否则先让未展示案例轮换。
  const imageEdit =
    unseen.find((item) => item.referenceImages?.length) ??
    (unseen.length === 0 || unseenNormal.length + seenNormal.length < HERO_CARD_COUNT
      ? seen.find((item) => item.referenceImages?.length)
      : undefined)
  if (imageEdit) {
    selected.push(imageEdit)
    categories.add(imageEdit.category)
  }
  // 对比卡占两列：首页最多选一张，余下四张普通卡恰好排满六列。
  const maxCards = imageEdit ? HERO_CARD_COUNT - 1 : HERO_CARD_COUNT
  for (const group of [unseenNormal, seenNormal]) {
    for (const item of group) {
      if (categories.has(item.category)) continue
      categories.add(item.category)
      selected.push(item)
      if (selected.length === maxCards) return selected
    }
    for (const item of group) {
      if (selected.includes(item)) continue
      selected.push(item)
      if (selected.length === maxCards) return selected
    }
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
