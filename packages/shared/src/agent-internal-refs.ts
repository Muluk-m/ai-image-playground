/**
 * 回复和建议句里不该给用户看的内部标识：产物 id（`agent_<任务>_<下标>`）、裸 UUID，
 * 以及调用方给出的批次项 key（BUG-56）。模型被要求只用名称称呼，这里兜它没照做的时候。
 *
 * Markdown 图片与链接整段原样保留：图片 `![说明](图片ID)` 是正经的引用方式，链接由渲染层决定
 * 能不能点（BUG-55），这里改写它们会把图片引用也弄坏。
 */
const AGENT_ARTIFACT_ID = String.raw`agent_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_\d+`
const UUID = String.raw`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`
/** `![x](y)` 与 `[x](y)`：整段跳过，不动。 */
const MARKDOWN_LINK = /!?\[[^\]\n]*\]\([^)\n]*\)/g

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
    wrapped: new RegExp(String.raw`[ \t]*[（(][ \t]*\x60?(?:${ref})\x60?[ \t]*[)）]`, 'gi'),
    // 「`animal-03-rabbit`」单独出现。
    ticked: new RegExp(String.raw`[ \t]*\x60(?:${ref})\x60`, 'gi'),
    // 裸写的 id 或像标识的 key；前后不能紧挨着字母数字，免得削掉别的词的一部分。
    bare: new RegExp(String.raw`(?<![A-Za-z0-9_-])(?:${bare})(?![A-Za-z0-9_-])`, 'gi'),
  }
}

function stripSegment(segment: string, patterns: ReturnType<typeof compile>): string {
  return (
    segment
      .replace(patterns.wrapped, '')
      .replace(patterns.ticked, '')
      .replace(patterns.bare, '')
      // 删完留下的「：、」「（）」这类空壳与多余空格。
      .replace(/[（(][ \t]*[)）]/g, '')
      .replace(/([，、；：])[ \t]*(?=[，、；：。])/g, '')
      .replace(/[ \t]{2,}/g, ' ')
  )
}

/** 去掉正文里的内部标识，Markdown 图片与链接原样不动。`keys` 是这段对话里批次项的 key。 */
export function stripInternalRefs(text: string, keys: readonly string[] = []): string {
  if (!text) return text
  const patterns = compile(keys)
  let out = ''
  let last = 0
  for (const match of text.matchAll(MARKDOWN_LINK)) {
    const at = match.index ?? 0
    out += stripSegment(text.slice(last, at), patterns) + match[0]
    last = at + match[0].length
  }
  return out + stripSegment(text.slice(last), patterns)
}
