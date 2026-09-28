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
  // 优先轮到上批未展示过的对比卡；不要为了凑对比而固定重复上一批的唯一案例。
  const imageEdit =
    pool.find((item) => item.referenceImages?.length && !previous.has(item.id)) ??
    (unseen.length === 0 ? pool.find((item) => item.referenceImages?.length) : undefined)
  if (imageEdit) {
    selected.push(imageEdit)
    categories.add(imageEdit.category)
  }
  // 对比卡占两列：首页最多选一张，余下四张普通卡恰好排满六列。
  const maxCards = imageEdit ? HERO_CARD_COUNT - 1 : HERO_CARD_COUNT
  const remaining = pool.filter(
    (item) => !item.referenceImages?.length || (!imageEdit && !previous.has(item.id)),
  )
  for (const item of remaining) {
    if (selected.includes(item)) continue
    if (categories.has(item.category)) continue
    categories.add(item.category)
    selected.push(item)
    if (selected.length === maxCards) return selected
  }
  for (const item of remaining) {
    if (!selected.includes(item)) selected.push(item)
    if (selected.length === maxCards) break
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
