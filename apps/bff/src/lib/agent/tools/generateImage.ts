import { agentTitleLine } from '@image-playground/shared'
import { Type } from 'typebox'
import { defineAgentTool } from './adapter'
import { agentImageCount, imageCountParameter } from './queueParams'
import { runQueueTask } from './queueTask'

const TITLE_MAX_CHARS = 40

const parameters = Type.Object({
  prompt: Type.String({
    description: '完整描述要画的画面，包含主体、场景与风格。用用户说话的语言写。',
  }),
  n: imageCountParameter,
})

export const generateImage = defineAgentTool({
  name: 'generateImage',
  label: '生图',
  description:
    '按提示词生成全新的图片，产出直接落到用户的画布上。可用 n 指定同一画面的版本数；改已有的图用 editImage。',
  guidance:
    '用户要新图时调生图工具，把意图补成完整提示词；细节自行补全，不要用开放式问题反问。方向本身拿不准时用澄清工具给出具体方案让他选。张数按用户需求选，未要求多张时只出一张；同一画面的多个版本用 n，不同画面分别调用。',
  parameters,
  onError: 'abort',
  call({ prompt, n }) {
    const written = typeof prompt === 'string' ? prompt : undefined
    return {
      title: written?.trim() ? agentTitleLine(written, TITLE_MAX_CHARS) : '生图',
      outputCount: agentImageCount({ n }),
      ...(written ? { prompt: written } : {}),
    }
  },
  execute: (context) => (toolCallId, params, signal, onUpdate) =>
    runQueueTask(
      context,
      { media: 'image', toolCallId, prompt: params.prompt, n: params.n },
      signal,
      onUpdate,
    ),
})
