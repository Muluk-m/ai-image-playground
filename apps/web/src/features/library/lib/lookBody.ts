export interface LookBodySection {
  readonly title: string
  readonly body: string
}

/** 模板正文按 `## N. 标题` 切段；标题去掉序号。开头的一级标题是技能标题（名字已经在别处显示），丢掉。 */
export function splitLookBody(body: string): LookBodySection[] {
  const trimmed = body.trim().replace(/^# [^\n]*\n*/, '')
  if (!trimmed) return []
  return trimmed
    .split(/\n(?=## )/)
    .map((block) => {
      const [head, ...rest] = block.split('\n')
      const isHeading = head.startsWith('## ')
      return {
        title: isHeading ? head.replace(/^## (\d+[.、]\s*)?/, '').trim() : '',
        body: (isHeading ? rest.join('\n') : block).trim(),
      }
    })
    .filter((section) => section.title || section.body)
}
