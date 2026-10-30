export const GEMINI_ASPECT_RATIOS = [
  '1:1',
  '16:9',
  '9:16',
  '4:3',
  '3:4',
  '3:2',
  '2:3',
  '4:5',
  '5:4',
  '21:9',
] as const
export const GEMINI_IMAGE_SIZES = ['512', '1K', '2K'] as const
export type GeminiImageSize = (typeof GEMINI_IMAGE_SIZES)[number]

/** 分辨率档位从低到高。含面板还没开放的 4K（还没分档定价），只用来给「最近一档」排序。 */
const IMAGE_SIZE_ORDER: readonly string[] = ['512', '1K', '2K', '4K']

/**
 * 模型不认这一档时换成它认的最近一档：距离相同取低的一档（不多扣、不多等）。认不出的值（不是
 * 档位名）给最低一档。模型认这一档就原样返回。`supported` 为空返回 undefined。
 * 面板按渠道声明（`ChannelModel.imageSizes`）只列支持的档位，这里兜的是旧任务重试、Agent 计划、
 * 存在本地的旧选择这类绕过面板的值。
 */
export function nearestImageSize<T extends string>(
  value: unknown,
  supported: readonly T[],
): T | undefined {
  if (supported.length === 0) return undefined
  if (typeof value === 'string' && (supported as readonly string[]).includes(value))
    return value as T
  const at = typeof value === 'string' ? IMAGE_SIZE_ORDER.indexOf(value) : -1
  const ranked = [...supported].sort(
    (a, b) => IMAGE_SIZE_ORDER.indexOf(a) - IMAGE_SIZE_ORDER.indexOf(b),
  )
  if (at < 0) return ranked[0]
  let best = ranked[0]!
  for (const one of ranked) {
    if (
      Math.abs(IMAGE_SIZE_ORDER.indexOf(one) - at) < Math.abs(IMAGE_SIZE_ORDER.indexOf(best) - at)
    )
      best = one
  }
  return best
}
export const GEMINI_THINKING_LEVELS = ['minimal', 'high'] as const
