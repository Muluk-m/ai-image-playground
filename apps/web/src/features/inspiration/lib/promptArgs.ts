export interface PromptSegment {
  type: 'text' | 'arg'
  text: string
  name?: string
}

function argumentPattern(): RegExp {
  return /\{argument name="([^"]*)" default="([^"]*)"\}/g
}

/** 复制和「做同款」用：占位符换成默认值，其余原文保留。 */
export function plainPrompt(prompt: string): string {
  return prompt.replace(argumentPattern(), (_match, _name: string, fallback: string) => fallback)
}

function formatPrompt(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2)
    } catch {
      // 不是合法 JSON，按原样显示。
    }
  }
  return raw
}

/** 详情里把默认值画成高亮，名字留给 title。JSON 提示词先格式化再切。 */
export function promptSegments(prompt: string): PromptSegment[] {
  const formatted = formatPrompt(prompt)
  const segments: PromptSegment[] = []
  let last = 0
  for (const match of formatted.matchAll(argumentPattern())) {
    const index = match.index ?? 0
    if (index > last) segments.push({ type: 'text', text: formatted.slice(last, index) })
    segments.push({ type: 'arg', text: match[2] ?? '', name: match[1] ?? '' })
    last = index + match[0].length
  }
  if (last < formatted.length || segments.length === 0) {
    segments.push({ type: 'text', text: formatted.slice(last) })
  }
  return segments
}

export function promptHasArguments(prompt: string): boolean {
  return promptSegments(prompt).some((segment) => segment.type === 'arg')
}
