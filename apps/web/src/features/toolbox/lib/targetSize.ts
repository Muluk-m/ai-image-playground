/**
 * 压到指定体积：在质量上二分，找不超过目标的最高质量。编码是注入的，纯逻辑可以单测。
 * 7 轮把 0.05–0.95 的区间缩到 0.007 以内，再细分体积也几乎不变，多一轮就是多一次整图编码。
 */
export const TARGET_SEARCH_ROUNDS = 7
export const MIN_QUALITY = 0.05
export const MAX_QUALITY = 0.95

export async function searchQualityForSize<T extends { size: number }>(
  encodeAt: (quality: number) => Promise<T>,
  targetBytes: number,
): Promise<{ result: T; overTarget: boolean }> {
  let low = MIN_QUALITY
  let high = MAX_QUALITY
  let best: T | null = null
  for (let round = 0; round < TARGET_SEARCH_ROUNDS; round++) {
    const quality = (low + high) / 2
    const attempt = await encodeAt(quality)
    if (attempt.size <= targetBytes) {
      best = attempt
      low = quality
    } else high = quality
  }
  if (best) return { result: best, overTarget: false }
  const floor = await encodeAt(MIN_QUALITY)
  return { result: floor, overTarget: floor.size > targetBytes }
}
