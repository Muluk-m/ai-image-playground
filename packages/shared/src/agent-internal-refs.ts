/**
 * 回复和建议句里不该给用户看的内部标识：产物 id（`agent_<任务>_<下标>`）、裸 UUID，
 * 以及调用方给出的批次项 key（BUG-56）。模型被要求只用名称称呼，这里兜它没照做的时候。
 *
 * Markdown 图片与链接整段原样保留：图片 `![说明](图片ID)` 是正经的引用方式，链接由渲染层决定
 * 能不能点（BUG-55），这里改写它们会把图片引用也弄坏。
 */
const AGENT_ARTIFACT_ID = String.raw`agent_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_\d+`
const UUID = String.raw`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 像标识的 key 才在裸文字里删；`cat` 这种普通词只在括号或反引号里删，免得误伤正文。 */
function identifierLike(key: string): boolean {
  return /^[A-Za-z0-9]+(?:[-_.][A-Za-z0-9]+)+$/.test(key) || /[A-Za-z].*\d|\d.*[A-Za-z]/.test(key)
}

function compile(keys: readonly string[]) {
  const usable = [...new Set(keys.map((key) => key.trim()).filter((key) => key.length >= 2))]
    // 长的先试：`a-1` 不能先吃掉 `a-1-b` 的前半截。
    .sort((a, b) => b.length - a.length)
  const anyKey = usable.map(escapeRegExp)
  const ref = [AGENT_ARTIFACT_ID, UUID, ...anyKey].join('|')
  const bare = [AGENT_ARTIFACT_ID, UUID, ...usable.filter(identifierLike).map(escapeRegExp)].join(
    '|',
  )
  return {
    // 「兔子图（`animal-03-rabbit`）」「(agent_…_0)」：连括号一起去掉。
    wrapped: new RegExp(String.raw`[（(][ \t]*\x60?(?:${ref})\x60?[ \t]*[)）]`, 'gi'),
    // 「`animal-03-rabbit`」单独出现。
    ticked: new RegExp(String.raw`\x60(?:${ref})\x60`, 'gi'),
    // 裸写的 id 或像标识的 key；前后不能紧挨着字母数字，免得削掉别的词的一部分。
    bare: new RegExp(String.raw`(?<![A-Za-z0-9_-])(?:${bare})(?![A-Za-z0-9_-])`, 'gi'),
  }
}

/** 删掉的位置先记成这个字符，再只在它两侧收拾空格与标点，别处的空白（缩进、硬换行）不动。 */
const CUT = '\u0000'
const OPEN = new Set(['（', '('])
const CLOSE = new Set(['）', ')'])
const PAUSE = new Set(['，', '、', '；', '：'])
const PAUSE_OR_STOP = new Set(['，', '、', '；', '：', '。', '！', '？'])
const WORD = /[A-Za-z0-9]/

/** 逐字收拾删除点：去掉两侧空格，留下的「（）」与「，，」并成一个。只走一遍，不回溯。 */
function tidyCuts(text: string): string {
  if (!text.includes(CUT)) return text
  const out: string[] = []
  let index = 0
  while (index < text.length) {
    const char = text[index] as string
    if (char !== CUT) {
      out.push(char)
      index += 1
      continue
    }
    let spaced = false
    while (out.length && (out[out.length - 1] === ' ' || out[out.length - 1] === '\t')) {
      out.pop()
      spaced = true
    }
    index += 1
    while (index < text.length && /[ \t\u0000]/.test(text[index] as string)) {
      if (text[index] !== CUT) spaced = true
      index += 1
    }
    const before = out[out.length - 1] ?? ''
    const after = text[index] ?? ''
    if (OPEN.has(before) && CLOSE.has(after)) {
      out.pop()
      index += 1
    } else if (PAUSE.has(before) && PAUSE_OR_STOP.has(after)) out.pop()
    else if (
      before &&
      after &&
      (spaced || (WORD.test(before) && WORD.test(after))) &&
      !OPEN.has(before) &&
      !PAUSE_OR_STOP.has(before) &&
      !CLOSE.has(after) &&
      !PAUSE_OR_STOP.has(after)
    )
      out.push(' ')
  }
  return out.join('')
}

function stripSegment(segment: string, patterns: ReturnType<typeof compile>): string {
  return tidyCuts(
    segment
      .replace(patterns.wrapped, CUT)
      .replace(patterns.ticked, CUT)
      .replace(patterns.bare, CUT),
  )
}

/**
 * 一行里的 Markdown 图片与链接 `![x](y)`、`[x](y)` 的位置。手写扫描而不是正则：
 * 成串的 `[` 会让正则逐个起点重扫到行尾（CodeQL 多项式回溯）。这里每一步都越过已看过的 `]`。
 */
function markdownLinks(line: string): [number, number][] {
  const found: [number, number][] = []
  let from = 0
  while (from < line.length) {
    const open = line.indexOf('[', from)
    if (open < 0) break
    const close = line.indexOf(']', open + 1)
    if (close < 0) break
    if (line[close + 1] !== '(') {
      from = close + 1
      continue
    }
    const end = line.indexOf(')', close + 2)
    if (end < 0) break
    const start = open > 0 && line[open - 1] === '!' ? open - 1 : open
    found.push([start, end + 1])
    from = end + 1
  }
  return found
}

/** 去掉正文里的内部标识，Markdown 图片与链接原样不动。`keys` 是这段对话里批次项的 key。 */
export function stripInternalRefs(text: string, keys: readonly string[] = []): string {
  if (!text) return text
  const patterns = compile(keys)
  return text
    .split('\n')
    .map((line) => {
      let out = ''
      let last = 0
      for (const [start, end] of markdownLinks(line)) {
        out += stripSegment(line.slice(last, start), patterns) + line.slice(start, end)
        last = end
      }
      return out + stripSegment(line.slice(last), patterns)
    })
    .join('\n')
}
