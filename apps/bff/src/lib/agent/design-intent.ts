/**
 * 设计意图是 Agent 对用户目标的解释，不是用户原话。它随最终提示词展示在草稿卡片里，
 * 让用户能在付费提交前看见并修改；直出请求不经过这里。
 */
export interface AgentDesignIntent {
  readonly message: string
  readonly focalPoint: string
  readonly visualPath?: string
  readonly mood?: string
}

function line(value: unknown): string | undefined {
  const flat = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : undefined
  return flat || undefined
}

const DESIGN_HEAD = '画面要表达（用视觉呈现，不作为图中文字）：'

/**
 * `designPrompt` 的逆：取回并入设计意图之前、模型写的那句提示词。卡面标题是从它截的，
 * 不是从并好的整段——整段开头永远是「画面要表达」，截出来每张卡都一样。没并过的原样返回。
 */
export function writtenPrompt(prompt: string): string {
  if (!prompt.startsWith(DESIGN_HEAD)) return prompt
  const at = prompt.indexOf('\n\n')
  return at < 0 ? prompt : prompt.slice(at + 2)
}

export function designPrompt(prompt: string, intent: unknown): string {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) return prompt
  const design = intent as Partial<AgentDesignIntent>
  const message = line(design.message)
  const focalPoint = line(design.focalPoint)
  if (!message || !focalPoint) return prompt
  const visualPath = line(design.visualPath)
  const mood = line(design.mood)
  return [
    `${DESIGN_HEAD}${message}`,
    `第一眼焦点：${focalPoint}`,
    ...(visualPath ? [`视线引导：${visualPath}`] : []),
    ...(mood ? [`情绪与氛围：${mood}`] : []),
    '',
    prompt,
  ].join('\n')
}
