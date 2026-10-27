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
 * 「共 N 张/项/幅」，以及中文数字写的「三张」「共三项」。
 */
export function recountBatchText(text: string, from: number, to: number): string {
  if (from === to || to < 1) return text
  return text
    .replace(
      new RegExp(`(共\\s*)${from}(\\s*[张项幅])`, 'g'),
      (_match, head: string, tail: string) => `${head}${to}${tail}`,
    )
    .replace(
      /(^|[^零一二两三四五六七八九十百千万0-9])([一二两三四五六七八九十]{1,3})(\s*[张项幅])/g,
      (match, lead: string, count: string, tail: string) =>
        parseChineseCount(count) === from && to < 100 ? `${lead}${chineseCount(to)}${tail}` : match,
    )
}
