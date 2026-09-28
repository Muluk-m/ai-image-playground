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

export function designPrompt(prompt: string, intent: unknown): string {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) return prompt
  const design = intent as Partial<AgentDesignIntent>
  const message = line(design.message)
  const focalPoint = line(design.focalPoint)
  if (!message || !focalPoint) return prompt
  const visualPath = line(design.visualPath)
  const mood = line(design.mood)
  return [
    `画面要表达（用视觉呈现，不作为图中文字）：${message}`,
    `第一眼焦点：${focalPoint}`,
    ...(visualPath ? [`视线引导：${visualPath}`] : []),
    ...(mood ? [`情绪与氛围：${mood}`] : []),
    '',
    prompt,
  ].join('\n')
}
