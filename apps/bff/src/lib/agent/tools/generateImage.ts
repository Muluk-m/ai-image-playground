import { agentTitleLine } from '@image-playground/shared'
import { Type } from 'typebox'
import { designPrompt } from '../design-intent'
import { defineAgentTool } from './adapter'
import { agentImageCount, imageCountParameter, reviewParameter } from './queueParams'
import { draftQueueTask, resolveAgentModel } from './queueTask'

const TITLE_MAX_CHARS = 40

const parameters = Type.Object({
  prompt: Type.String({
    description:
      '给上游的完整生图提示词。用户要直出时就是他的原文，一字不改；否则写成简报，按「用途、主体、场景、画风、构图、光线与氛围、配色、材质、图中文字（原样）、约束」逐行写，只写有用的行，用用户说话的语言写。上游原样执行、不会替你补设计。',
  }),
  designIntent: Type.Optional(
    Type.Object({
      message: Type.String({
        minLength: 1,
        maxLength: 300,
        description: '这张图最终要让观众理解或感受到什么。写传播目标，不要重复主体名。',
      }),
      focalPoint: Type.String({
        minLength: 1,
        maxLength: 200,
        description: '观众第一眼应看到的具体画面对象或关系。',
      }),
      visualPath: Type.Optional(
        Type.String({
          maxLength: 300,
          description: '视线从焦点走向哪里；只写画面中实际会出现的次要内容。',
        }),
      ),
      mood: Type.Optional(
        Type.String({ maxLength: 120, description: '要传达的情绪；不确定时省略。' }),
      ),
    }),
  ),
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
    '用户要新图时调生图工具。先判断他是不是要用自己的提示词直出：不是口语、有结构有格式、各方面都写清楚的提示词（关键词串、英文 prompt、分行标签、带参数）大概率是，这时原文一字不改作为 prompt，不填 designIntent；拿不准是要原样用还是要你加工时，用澄清工具让他在「按原文直出」与「补全后再生成」之间选。不是直出时先确定这张图要表达什么、观众第一眼看什么，再填 designIntent；它会并入最终可编辑的提示词。用户要求具体时只整理成简报，不另加创意；只给笼统想法时按适用技能做美术指导，确定用途、焦点与视线顺序、构图、光线、配色和质感，让每一项为表达目标服务。方向不明且不同解读会明显改变结果时才用澄清工具。不添加请求里没暗示的人物、道具、品牌、文案；图中文字逐字引用。调用前一句话说清替用户定了什么，拟稿后这一轮就结束。未要求多张时只出一张；同一画面的多个版本用 n，不同方向分别调用。不要为同一件事调第二次。',
  parameters,
  onError: 'abort',
  target: (params) => resolveAgentModel('image', params?.model),
  call({ prompt, designIntent, n }) {
    const written = typeof prompt === 'string' ? prompt : undefined
    const finalPrompt = written ? designPrompt(written, designIntent) : undefined
    return {
      title: written?.trim() ? agentTitleLine(written, TITLE_MAX_CHARS) : '生图',
      outputCount: agentImageCount({ n }),
      ...(finalPrompt ? { prompt: finalPrompt } : {}),
    }
  },
  execute: (context) => async (toolCallId, params, signal) =>
    draftQueueTask(
      context,
      {
        toolName: 'generateImage',
        media: 'image',
        toolCallId,
        prompt: designPrompt(params.prompt, params.designIntent),
        n: params.n,
        review: params.reviewAfterCompletion === true,
      },
      signal,
    ),
})
