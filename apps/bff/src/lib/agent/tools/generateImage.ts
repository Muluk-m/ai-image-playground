import { agentTitleLine } from '@image-playground/shared'
import { Type } from 'typebox'
import { defineAgentTool } from './adapter'
import { agentImageCount, imageCountParameter, reviewParameter } from './queueParams'
import { draftQueueTask, resolveAgentModel } from './queueTask'

const TITLE_MAX_CHARS = 40

const parameters = Type.Object({
  prompt: Type.String({
    description: '完整描述要画的画面，包含主体、场景与风格。用用户说话的语言写。',
  }),
  n: imageCountParameter,
  reviewAfterCompletion: reviewParameter,
})

export const generateImage = defineAgentTool({
  name: 'generateImage',
  // 视频轮也要它：首帧先画出来，才有东西可以动。
  modes: ['image', 'video'],
  label: '生图',
  // 拟稿即收尾：提示词交给用户确认，不提交任务、不落画布。
  confirms: true,
  description:
    '按提示词拟一份生图草稿交给用户确认。调用后立即返回「等待确认」：没有提交任务，也没有产生费用；用户可以在卡片上改提示词，点「确认生成」之后系统才按他确认的那一份提交，图在后台生成并落到画布上。可用 n 指定同一画面的版本数；改已有的图用 editImage。',
  guidance:
    '用户要新图时调生图工具，把意图补成完整提示词；细节自行补全，不要用开放式问题反问。方向本身拿不准时用澄清工具给出具体方案让他选。提示词里只写用户要的与画面必需的；他没说过的颜色、材质、风格不要替他定死——那一句会原样送进上游。张数按用户需求选，未要求多张时只出一张；同一画面的多个版本用 n，不同画面分别调用。工具只拟稿不提交，提交由用户在卡片上确认，所以不要说已经开始画，也不要为同一件事拟第二次稿。',
  parameters,
  onError: 'abort',
  target: (params) => resolveAgentModel('image', params?.model),
  call({ prompt, n }) {
    const written = typeof prompt === 'string' ? prompt : undefined
    return {
      title: written?.trim() ? agentTitleLine(written, TITLE_MAX_CHARS) : '生图',
      outputCount: agentImageCount({ n }),
      ...(written ? { prompt: written } : {}),
    }
  },
  execute: (context) => async (toolCallId, params, signal) =>
    draftQueueTask(
      context,
      {
        toolName: 'generateImage',
        media: 'image',
        toolCallId,
        prompt: params.prompt,
        n: params.n,
        review: params.reviewAfterCompletion === true,
      },
      signal,
    ),
})
