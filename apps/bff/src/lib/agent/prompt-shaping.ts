import type { QueueProvider } from '@image-playground/shared'
import { buildAspectInstruction } from '@image-playground/shared'
import { modelCapabilities } from '../channels'

export interface QueuePromptInput {
  readonly provider: QueueProvider
  readonly model: string
  /** 用户确认的那一句，不带任何机器指令。 */
  readonly prompt: string
  /** 这次提交带的 `size`；缺席即没选尺寸。 */
  readonly size?: string
}

/** 只补未声明 size 能力时的构图句；防改写由上游选路后按 no_rewrite 决定。 */
export function shapeQueuePrompt(input: QueuePromptInput): string {
  let prompt = input.prompt
  const capabilities = modelCapabilities(input.model)
  // 声明过能力、且其中没有 size 的模型才需要构图指令；没声明过的按支持 size 处理。
  if (!input.size || !capabilities || capabilities.includes('size')) return prompt
  const instruction = buildAspectInstruction(input.size)
  if (!instruction || prompt.endsWith(instruction)) return prompt
  return `${prompt}\n\n${instruction}`
}
