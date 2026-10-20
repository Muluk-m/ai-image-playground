import type { InspirationItem } from '../types'

/** 一次页面加载一个种子。刷新换种子；同一轮渲染和滚动都复用它。 */
export function createSeed(): number {
  const buffer = new Uint32Array(1)
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(buffer)
    return buffer[0] ?? 0
  }
  return Math.floor(Math.random() * 2 ** 32)
}

/** mulberry32。返回值落在 [0, 1)。 */
export function unitRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const pool = [...items]
  const random = unitRandom(seed)
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1))
    const current = pool[index]
    pool[index] = pool[swap] as T
    pool[swap] = current as T
  }
  return pool
}

/** 没封面的不能进瀑布；同一 id 只留第一次出现的那条。 */
export function inspirationFeedOrder(
  items: readonly InspirationItem[],
  seed: number,
): InspirationItem[] {
  const seen = new Set<string>()
  const unique: InspirationItem[] = []
  for (const item of items) {
    if (!item.thumbnailUrl || seen.has(item.id)) continue
    seen.add(item.id)
    unique.push(item)
  }
  return seededShuffle(unique, seed)
}
