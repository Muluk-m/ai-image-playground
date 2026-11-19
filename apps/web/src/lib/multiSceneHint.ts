/** 提示词里要 2–10 个不同场景、但当前只会出 1 张时，用来判断是否给出说明。 */

const MIN_COUNT = 2
const MAX_COUNT = 10

const CN_COUNTS: Record<string, number> = {
  两: 2,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
}

const EN_COUNTS: Record<string, number> = {
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
}

/** 拼图 / 宫格 / 分镜等「一张图里排多个画面」的写法，不是要分别出多张。 */
const GRID_RE = /拼图|宫格|九宫格|分镜|拼接|一张图里|合成一张|collage|storyboard|\bgrids?\b/i

/**
 * 2–10：阿拉伯数字、中文数词、英文数词。
 * 不吃「十六」「六十」「11」「12」这类更大的数。
 */
const COUNT_TOKEN =
  '(?<!\\d)(?:10|[2-9])(?!\\d)|' +
  '(?<![十零一二三四五六七八九两])(?:两|十|[二三四五六七八九])(?![十零一二三四五六七八九十几多])|' +
  '\\b(?:two|three|four|five|six|seven|eight|nine|ten)\\b'

/** 张/幅本身就是出图数量，后面的名词可以省略（「六张不同的」）。 */
const ZH_SHEET_RE = new RegExp(
  `(${COUNT_TOKEN})\\s*(?:张|幅)\\s*不同(?:的)?(?:场景|画面|图|风格|角度|构图)?`,
  'u',
)

/** 个/种/套必须跟场景类名词，避免「两个不同年龄的人」被当成要出两张。 */
const ZH_SCENE_RE = new RegExp(
  `(${COUNT_TOKEN})\\s*(?:个|种|套)\\s*不同(?:的)?(?:场景|画面|图|风格|角度|构图)`,
  'u',
)

const EN_SCENE_RE = new RegExp(
  `(${COUNT_TOKEN})\\s+different\\s+(?:scenes?|images?|pictures?|photos?|styles?|angles?|shots?|looks?)`,
  'iu',
)

function parseCount(raw: string): number | null {
  if (/^[0-9]+$/.test(raw)) {
    const n = Number(raw)
    return n >= MIN_COUNT && n <= MAX_COUNT ? n : null
  }
  const cn = CN_COUNTS[raw]
  if (cn !== undefined) return cn
  const en = EN_COUNTS[raw.toLowerCase()]
  return en ?? null
}

function firstRequestedCount(prompt: string): number | null {
  let found: { index: number; count: number } | null = null
  for (const pattern of [ZH_SHEET_RE, ZH_SCENE_RE, EN_SCENE_RE]) {
    pattern.lastIndex = 0
    for (const match of prompt.matchAll(
      new RegExp(pattern.source, pattern.flags.includes('i') ? 'giu' : 'gu'),
    )) {
      if (match.index === undefined) continue
      const count = parseCount(match[1] ?? '')
      if (count === null) continue
      if (!found || match.index < found.index) found = { index: match.index, count }
    }
  }
  return found?.count ?? null
}

/** 提示词要的不同场景数；对不上或是拼图/宫格/分镜时返回 null。 */
export function detectRequestedSceneCount(prompt: string): number | null {
  const text = prompt.trim()
  if (!text || GRID_RE.test(text)) return null
  return firstRequestedCount(text)
}

export function shouldShowMultiSceneHint(input: {
  prompt: string
  imageCount: number
  creationMode: string
  dismissedPrompt?: string | null
}): number | null {
  if (input.creationMode !== 'image') return null
  if (input.imageCount !== 1) return null
  if (input.dismissedPrompt === input.prompt) return null
  return detectRequestedSceneCount(input.prompt)
}
