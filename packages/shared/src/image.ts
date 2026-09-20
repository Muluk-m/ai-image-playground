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

const IMAGE_SIZE_PATTERN = /^\s*(\d+)\s*[xX×]\s*(\d+)\s*$/

/**
 * `宽x高` 尺寸串 → 两个数。`x` / `X` / `×` 都认，两侧允许空白；对不上格式即 null。
 *
 * 尺寸归一化、比例标签与发给上游的构图指令共用它：各处自己写一条正则，迟早会在认不认
 * `×`、容不容空白上分叉，同一个尺寸串在两处得出不同结论。
 */
export function parseImageSize(
  size: string,
): { readonly width: number; readonly height: number } | null {
  const match = size.match(IMAGE_SIZE_PATTERN)
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null
}

/**
 * 像素尺寸 → 人读的比例标签。精确命中常用比例就直接给，否则退到最接近的那一档并冠以 `≈`。
 *
 * 界面标签与构图指令同取它：卡片上写着 16:9，发给上游的那句就得是 16:9。
 */
export function formatImageRatio(width: number, height: number) {
  const roundedWidth = Math.round(width)
  const roundedHeight = Math.round(height)
  if (
    !Number.isFinite(roundedWidth) ||
    !Number.isFinite(roundedHeight) ||
    roundedWidth <= 0 ||
    roundedHeight <= 0
  ) {
    return ''
  }

  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))
  const divisor = gcd(roundedWidth, roundedHeight)
  const simplifiedWidth = roundedWidth / divisor
  const simplifiedHeight = roundedHeight / divisor
  const simplified = `${simplifiedWidth}:${simplifiedHeight}`
  const commonRatios = [
    [1, 1],
    [4, 3],
    [3, 4],
    [3, 2],
    [2, 3],
    [16, 9],
    [9, 16],
    [21, 9],
    [9, 21],
  ]

  for (const [commonWidth, commonHeight] of commonRatios) {
    if (simplifiedWidth === commonWidth && simplifiedHeight === commonHeight) {
      return simplified
    }
  }

  // 精确的小项分数已经是最友好的标签；继续寻找别名只会把 5:4 换成等值但更难读的 10:8。
  if (simplifiedWidth <= 12 && simplifiedHeight <= 12) return simplified

  const actualRatio = roundedWidth / roundedHeight
  const squareDelta = Math.abs(actualRatio - 1)
  if (squareDelta <= 0.18) return '≈1:1'

  const nearest = commonRatios
    .map(([commonWidth, commonHeight]) => {
      const ratio = commonWidth / commonHeight
      return {
        label: `${commonWidth}:${commonHeight}`,
        delta: Math.abs(actualRatio - ratio) / ratio,
      }
    })
    .sort((a, b) => a.delta - b.delta)[0]

  // 16 倍数与最大边长钳制会让派生尺寸漂移约 1.6%；此时保留用户选择的常用比例比显示 7:3 更准确。
  if (nearest && nearest.delta <= 0.02) return `≈${nearest.label}`

  const friendlyNearest = Array.from({ length: 12 }, (_, widthIndex) => widthIndex + 1)
    .flatMap((friendlyWidth) =>
      Array.from({ length: 12 }, (_, heightIndex) => heightIndex + 1).map((friendlyHeight) => {
        const ratio = friendlyWidth / friendlyHeight
        const delta = Math.abs(actualRatio - ratio) / ratio
        return {
          label: `${friendlyWidth}:${friendlyHeight}`,
          delta,
          // 在误差接近时偏向更短、更好读的比例，例如 7:6 优于 8:7。
          score: delta + (friendlyWidth + friendlyHeight) * 0.002,
        }
      }),
    )
    .filter((item) => item.label !== simplified)
    .sort((a, b) => a.score - b.score)[0]

  return friendlyNearest && friendlyNearest.delta <= 0.04 ? `≈${friendlyNearest.label}` : simplified
}
