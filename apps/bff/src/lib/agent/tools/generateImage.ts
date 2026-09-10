import type { AgentTool } from '@earendil-works/pi-agent-core'
import { agentTitleLine } from '@image-playground/shared'
import { Type } from 'typebox'
import { runQueueTask } from './queueTask'
import type { AgentToolDefinition, AgentToolDetails } from './types'

const TITLE_MAX_CHARS = 40

const parameters = Type.Object({
  prompt: Type.String({
    description: '完整描述要画的画面，包含主体、场景与风格。用用户说话的语言写。',
  }),
})

function title(args: unknown): string {
  const prompt = (args as { prompt?: unknown } | null)?.prompt
  return typeof prompt === 'string' && prompt.trim()
    ? agentTitleLine(prompt, TITLE_MAX_CHARS)
    : '生图'
}

export const generateImage: AgentToolDefinition = {
  name: 'generateImage',
  title,
  onError: 'abort',
  create(context) {
    const tool: AgentTool<typeof parameters, AgentToolDetails> = {
      name: 'generateImage',
      label: '生图',
      description:
        '按提示词生成一张全新的图片，产出直接落到用户的画布上。用户想要一张新图时调用它；改已有的图用 editImage。',
      parameters,
      execute: (_toolCallId, params, signal, onUpdate) =>
        runQueueTask(context, { media: 'image', prompt: params.prompt }, signal, onUpdate),
    }
    return tool as AgentTool
  },
}
