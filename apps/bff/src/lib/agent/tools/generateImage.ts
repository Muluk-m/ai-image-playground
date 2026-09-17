import type { AgentTool } from '@earendil-works/pi-agent-core'
import { agentTitleLine } from '@image-playground/shared'
import { Type } from 'typebox'
import { agentImageCount, imageCountParameter } from './queueParams'
import { runQueueTask } from './queueTask'
import type { AgentToolDefinition, AgentToolDetails } from './types'

const TITLE_MAX_CHARS = 40

const parameters = Type.Object({
  prompt: Type.String({
    description: '完整描述要画的画面，包含主体、场景与风格。用用户说话的语言写。',
  }),
  n: imageCountParameter,
})

function title(args: unknown): string {
  const prompt = (args as { prompt?: unknown } | null)?.prompt
  return typeof prompt === 'string' && prompt.trim()
    ? agentTitleLine(prompt, TITLE_MAX_CHARS)
    : '生图'
}

export const generateImage: AgentToolDefinition = {
  name: 'generateImage',
  guidance:
    '用户要新图时调生图工具，把意图补成完整提示词，不要反问风格。张数按用户需求选，未要求多张时只出一张；同一画面的多个版本用 n，不同画面分别调用。',
  title,
  outputCount: agentImageCount,
  onError: 'abort',
  create(context) {
    const tool: AgentTool<typeof parameters, AgentToolDetails> = {
      name: 'generateImage',
      label: '生图',
      description:
        '按提示词生成全新的图片，产出直接落到用户的画布上。可用 n 指定同一画面的版本数；改已有的图用 editImage。',
      parameters,
      execute: (toolCallId, params, signal, onUpdate) =>
        runQueueTask(
          context,
          { media: 'image', toolCallId, prompt: params.prompt, n: params.n },
          signal,
          onUpdate,
        ),
    }
    return tool as AgentTool
  },
}
