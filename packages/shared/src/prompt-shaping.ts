import { formatImageRatio, parseImageSize } from './image'
import type { QueueProvider } from './queue-protocol'

/** 旧请求可能已带此前缀；新请求只在需要防改写的网关发送前添加。 */
export const PROMPT_REWRITE_GUARD_PREFIX =
  'Use the following text as the complete prompt. Do not rewrite it:'

export function applyPromptRewriteGuard(prompt: string): string {
  return `${PROMPT_REWRITE_GUARD_PREFIX}\n${prompt}`
}

/**
 * 某些上游会丢弃 `size`，只服从 prompt 中明确写出的构图比例。声明了 `size` 能力的模型不需要
 * 这一段——尺寸参数本身就生效，再写一遍反而多一条与参数打架的指令。
 */
export function buildAspectInstruction(size: string): string | null {
  const parsed = parseImageSize(size)
  if (!parsed) return null

  const { width, height } = parsed
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null
  }

  if (width === height) return 'Composition: a 1:1 square frame.'

  const ratio = formatImageRatio(width, height).replace(/^≈/, '')
  return width > height
    ? `Composition: a wide ${ratio} landscape frame, horizontal orientation.`
    : `Composition: a tall ${ratio} vertical frame, portrait orientation.`
}

/**
 * `shapeQueuePrompt` 的逆：从落库的那一句取回用户当初确认的原文。
 *
 * 进程死在「建任务」与「写回卡片」之间时，卡片要从任务的 payload 里回填提示词——那一句
 * 带着提交时钉上去的机器指令，原样写回卡面就把 guard 前缀摆到用户眼前，标题也会从它重算。
 * 两段都是精确的前缀 / 后缀，剥得干净；没被钉过的（视频、Gemini）原样返回。
 */
export function unshapeQueuePrompt(input: {
  readonly provider?: QueueProvider
  readonly prompt: string
  readonly size?: string
  /** 新请求单独保存防改写选项，原文中出现的同句前缀不能剥掉。 */
  readonly stripRewriteGuard?: boolean
}): string {
  let prompt = input.prompt
  const instruction = input.size ? buildAspectInstruction(input.size) : null
  const suffix = instruction ? `\n\n${instruction}` : ''
  if (suffix && prompt.endsWith(suffix)) prompt = prompt.slice(0, -suffix.length)
  if (input.provider === 'gemini' || input.stripRewriteGuard === false) return prompt
  const guard = `${PROMPT_REWRITE_GUARD_PREFIX}\n`
  return prompt.startsWith(guard) ? prompt.slice(guard.length) : prompt
}
