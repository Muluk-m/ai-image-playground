/** 删减处理项后，标题和统一规则里写死的「共 N 张/项」跟着改成实际项数（OBS-ACC-1）。 */
export function recountBatchText(text: string, from: number, to: number): string {
  if (from === to) return text
  return text.replace(
    new RegExp(`(共\\s*)${from}(\\s*[张项幅])`, 'g'),
    (_match, head: string, tail: string) => `${head}${to}${tail}`,
  )
}
