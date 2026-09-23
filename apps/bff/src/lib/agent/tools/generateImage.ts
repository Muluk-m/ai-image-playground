import { agentTitleLine } from '@image-playground/shared'
import { Type } from 'typebox'
import { defineAgentTool } from './adapter'
import { agentImageCount, imageCountParameter, reviewParameter } from './queueParams'
import { draftQueueTask, resolveAgentModel } from './queueTask'

const TITLE_MAX_CHARS = 40

const parameters = Type.Object({
  prompt: Type.String({
    description:
      '给上游的完整生图简报，按「用途、主体、场景、画风、构图、光线与氛围、配色、材质、图中文字（原样）、约束」逐行写，只写有用的行。上游原样执行、不会替你补设计。用用户说话的语言写。',
  }),
  n: imageCountParameter,
  reviewAfterCompletion: reviewParameter,
})

export const generateImage = defineAgentTool({
  name: 'generateImage',
  // 视频轮也要它：首帧先画出来，才有东西可以动。
  modes: ['image', 'video'],
  label: '生图',
  // 拟稿即收尾：对话模式下提示词交给用户确认，不提交任务、不落画布。出图模式当场提交。
  confirms: true,
  description:
    '按提示词发起一次生图，图落到画布上。可用 n 指定同一画面的版本数；改已有的图用 editImage。提交前要不要先等用户确认由系统决定，见系统提示词里的生成流程那一段——工具返回的那句话会说清这一次到底提交了没有，照它说。',
  guidance:
    '用户要新图时调生图工具，把意图补成完整提示词；细节自行补全，不要用开放式问题反问。方向本身拿不准时用澄清工具给出具体方案让他选。用户写得具体时只整理成简报，不另加创意；只给了一句笼统想法时替他做美术指导：定用途、构图与景别、光线、2-3 个具体配色、材质与画风，让画面有明确取向，并在调用前用一句话说明你定了哪些——拟稿后这一轮就结束，事后没有机会再补。不添加请求里没暗示的人物、道具、品牌、文案；图中文字写在引号里并要求逐字渲染。张数按用户需求选，未要求多张时只出一张；同一画面的多个版本用 n，不同方向分别调用。不要为同一件事调第二次。',
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
