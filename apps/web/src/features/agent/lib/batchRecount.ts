const DIGITS = '零一二三四五六七八九'

/** 1–99 的中文写法；2 写「两」（两张、两项）。 */
function chineseCount(n: number): string {
  if (n === 2) return '两'
  if (n < 10) return DIGITS[n] ?? String(n)
  const tens = Math.floor(n / 10)
  const ones = n % 10
  return `${tens === 1 ? '' : DIGITS[tens]}十${ones ? DIGITS[ones] : ''}`
}

function parseChineseCount(text: string): number | null {
  if (text === '两') return 2
  const at = text.indexOf('十')
  if (at < 0) return text.length === 1 ? DIGITS.indexOf(text) : null
  const tens = at === 0 ? 1 : DIGITS.indexOf(text.slice(0, at))
  const ones = at === text.length - 1 ? 0 : DIGITS.indexOf(text.slice(at + 1))
  return tens > 0 && ones >= 0 ? tens * 10 + ones : null
}

/**
 * 删减处理项后，标题和统一规则里写死的总数跟着改成实际项数（OBS-ACC-1）：
 * 「共 N 张/项/幅」，以及中文数字写的「共三项」和句首的「三张…」。
 * 「第三张」「每组三张」这类序数和局部数量不改：中文数字只认「共」后或句首（文本开头、标点或换行之后，可隔空白）。
 */
export function recountBatchText(text: string, from: number, to: number): string {
  if (from === to || to < 1) return text
  return text
    .replace(
      new RegExp(`(共\\s*)${from}(\\s*[张项幅])`, 'g'),
      (_match, head: string, tail: string) => `${head}${to}${tail}`,
    )
    .replace(
      /((?:^|[，。；、,.;:：！？!?\n（(「]|共)\s*)([一二两三四五六七八九十]{1,3})(\s*[张项幅])/g,
      (match, lead: string, count: string, tail: string) =>
        parseChineseCount(count) === from && to < 100 ? `${lead}${chineseCount(to)}${tail}` : match,
    )
}

const LIST_RUN = /[\p{Script=Han}A-Za-z0-9]+(?:、[\p{Script=Han}A-Za-z0-9]+)+/gu
const LIST_COUNT = /^(\d{1,2}|[一二两三四五六七八九十]{1,3})(\s*[张项幅])/

/** 列表项里只属于被删项、不属于任何保留项的名字（首项取后缀、末项取前缀、中间取整项）。 */
function removedName(
  part: string,
  side: 'first' | 'middle' | 'last',
  removed: string,
  kept: readonly string[],
): string | null {
  const owned = (name: string) =>
    name.length >= 2 && removed.includes(name) && !kept.some((prompt) => prompt.includes(name))
  if (side === 'middle') return owned(part) ? part : null
  for (let length = part.length; length >= 2; length -= 1) {
    const name = side === 'first' ? part.slice(part.length - length) : part.slice(0, length)
    if (owned(name)) return name
  }
  return null
}

/**
 * 删掉某项后，把标题和统一规则里用「、」列举的这一项去掉，并改写紧跟在列举后的张数（BUG-39）：
 * 「分别创作香蕉、葡萄、橙子三张」删掉橙子后变成「分别创作香蕉、葡萄两张」。
 * 只删被删项提示词里有、保留项提示词里都没有的名字；拿不准就不改，交给用户自己改。
 */
export function pruneRemovedFromList(
  text: string,
  removedPrompt: string,
  keptPrompts: readonly string[],
): string {
  return text.replace(LIST_RUN, (run) => {
    const parts = run.split('、')
    const last = parts.length - 1
    let head = ''
    let tail = ''
    const names: string[] = []
    let dropped = 0
    for (const [index, part] of parts.entries()) {
      const side = index === 0 ? 'first' : index === last ? 'last' : 'middle'
      const name = removedName(part, side, removedPrompt, keptPrompts)
      if (side === 'first') head = name ? part.slice(0, part.length - name.length) : ''
      if (side === 'last') tail = name ? part.slice(name.length) : ''
      if (name) {
        dropped += 1
        continue
      }
      names.push(side === 'first' ? part.slice(head.length) : side === 'last' ? part : part)
    }
    if (dropped === 0 || names.length === 0) return run
    if (!tail) {
      // 末项保留：它自带的「三张」还挂在末项后面，拆出来以便改数。
      const kept = names[names.length - 1]!
      const at = kept.search(/(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*[张项幅]$/)
      if (at > 0) {
        tail = kept.slice(at)
        names[names.length - 1] = kept.slice(0, at)
      }
    }
    const count = LIST_COUNT.exec(tail)
    if (count) {
      const before = /^\d/.test(count[1]!) ? Number(count[1]) : parseChineseCount(count[1]!)
      if (before === parts.length) {
        const after = parts.length - dropped
        tail = `${/^\d/.test(count[1]!) ? after : chineseCount(after)}${tail.slice(count[1]!.length)}`
      }
    }
    return `${head}${names.join('、')}${tail}`
  })
}
