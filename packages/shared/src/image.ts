/** 上传与抠图接受的图片 content-type。 */
export const IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
] as const

/** 数的是 data URL 字符数，不是解码后的字节数。 */
export const IMAGE_DATA_URL_MAX_CHARS = 4_000_000

/**
 * Gemini 只接受这几档 aspectRatio。顺序不影响结果，取的是数值上最接近的那一档。
 */
const GEMINI_ASPECT_RATIOS: ReadonlyArray<{ label: string; value: number }> = [
  { label: '1:1', value: 1 },
  { label: '16:9', value: 16 / 9 },
  { label: '9:16', value: 9 / 16 },
  { label: '4:3', value: 4 / 3 },
  { label: '3:4', value: 3 / 4 },
]

/**
 * 把 OpenAI 的 `宽x高` size 归到 Gemini 最接近的那一档 aspectRatio。
 *
 * 放在 shared 是因为三条路都要它：BYOK 直连、队列直接生成、智能体工具提交。
 * 各自照着档位表重写一遍必然对不齐——1024x1536 实际是 2:3，而这张表里没有 2:3，
 * 正确答案是 3:4，凭印象写就会写错。
 */
export function nearestAspectRatio(size: string): string | undefined {
  const match = size.match(/^(\d+)x(\d+)$/i)
  if (!match) return undefined

  const width = Number(match[1])
  const height = Number(match[2])
  if (!width || !height) return undefined

  const ratio = width / height
  let best = GEMINI_ASPECT_RATIOS[0]
  let bestDelta = Number.POSITIVE_INFINITY
  for (const candidate of GEMINI_ASPECT_RATIOS) {
    const delta = Math.abs(candidate.value - ratio)
    if (delta < bestDelta) {
      best = candidate
      bestDelta = delta
    }
  }
  return best.label
}
