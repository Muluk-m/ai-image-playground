import type { QueueProvider } from '@image-playground/shared'
import {
  applyPromptRewriteGuard,
  buildAspectInstruction,
  PROMPT_REWRITE_GUARD_PREFIX,
} from '@image-playground/shared'
import { modelCapabilities } from '../channels'

export interface QueuePromptInput {
  readonly provider: QueueProvider
  readonly model: string
  /** 用户确认的那一句，不带任何机器指令。 */
  readonly prompt: string
  /** 这次提交带的 `size`；缺席即没选尺寸。 */
  readonly size?: string
}

/**
 * 用户确认的提示词 → 真正发给上游的那一句。
 *
 * 创作页在 `callImageApi` 分发层给 prompt 加两段机器指令（防改写 guard 前缀、模型丢 `size`
 * 时的构图指令），智能体这条路以前一段都不加：同一个模型、同一句话，两边出图质感对不上。
 * 这里补齐同一份变换，用的还是 shared 里那一份实现，不再各写各的。
 *
 * **只在提交那一刻调用。** 草稿卡上展示、让用户编辑的必须是不带机器指令的原句——用户会把
 * 看不懂的英文指令删掉，或者照着它改，两种都会把变换弄坏。
 *
 * 幂等：已经带 guard 前缀 / 已经以同一句构图指令结尾的提示词原样返回，重放确认不会叠加。
 */
export function shapeQueuePrompt(input: QueuePromptInput): string {
  let prompt = input.prompt
  // Gemini 没有 prompt rewriting 这回事（创作页也不给它加），带上只是多一句噪声。
  if (input.provider !== 'gemini' && !prompt.startsWith(`${PROMPT_REWRITE_GUARD_PREFIX}\n`)) {
    prompt = applyPromptRewriteGuard(prompt)
  }
  const capabilities = modelCapabilities(input.model)
  // 声明过能力、且其中没有 size 的模型才需要构图指令；没声明过的按支持 size 处理。
  if (!input.size || !capabilities || capabilities.includes('size')) return prompt
  const instruction = buildAspectInstruction(input.size)
  if (!instruction || prompt.endsWith(instruction)) return prompt
  return `${prompt}\n\n${instruction}`
}

/**
 * `shapeQueuePrompt` 的逆：从落库的那一句取回用户当初确认的原文。
 *
 * 进程死在「建任务」与「写回卡片」之间时，卡片要从任务的 payload 里回填提示词——那一句
 * 带着提交时钉上去的机器指令，原样写回卡面就把 guard 前缀摆到用户眼前，标题也会从它重算。
 * 两段都是精确的前缀 / 后缀，剥得干净；没被钉过的（视频、Gemini）原样返回。
 */
export function unshapeQueuePrompt(input: {
  readonly prompt: string
  readonly size?: string
}): string {
  let prompt = input.prompt
  const instruction = input.size ? buildAspectInstruction(input.size) : null
  const suffix = instruction ? `\n\n${instruction}` : ''
  if (suffix && prompt.endsWith(suffix)) prompt = prompt.slice(0, -suffix.length)
  const guard = `${PROMPT_REWRITE_GUARD_PREFIX}\n`
  return prompt.startsWith(guard) ? prompt.slice(guard.length) : prompt
}
