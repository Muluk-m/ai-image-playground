import {
  ARRANGE_CAPTION_MAX,
  ARRANGE_MAX_ITEMS,
  ARRANGE_SECTION_MAX,
} from '@image-playground/shared'
import { Type } from 'typebox'
import { loadAgentCanvas } from '../canvas-view'
import { defineAgentTool } from './adapter'
import { AgentToolError } from './errors'

const parameters = Type.Object({
  groups: Type.Array(
    Type.Object({
      label: Type.Optional(
        Type.String({
          maxLength: ARRANGE_SECTION_MAX,
          description: '这一组左上角的大页签，一组一行。每张都有自己的名字时可以不写。',
        }),
      ),
      columns: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 12,
          description: '这一组排成几列。不写就收成接近方形的格子。',
        }),
      ),
      items: Type.Array(
        Type.Object({
          elementId: Type.String({
            description: '要排进去的图片元素 id，取自看画布报出来的「元素 xxx」。不是图片 id。',
          }),
          caption: Type.Optional(
            Type.String({
              maxLength: ARRANGE_CAPTION_MAX,
              description: '贴在这张图上方的小页签。不写就保持它现在的名字。',
            }),
          ),
        }),
        { minItems: 1, maxItems: ARRANGE_MAX_ITEMS },
      ),
    }),
    { minItems: 1, maxItems: 20, description: '按阅读顺序。一组是一块格子，组与组左右分开。' },
  ),
})

/**
 * 按内容把画布上的图收成几块，并写上页签。不生成东西、不花积分。
 *
 * 分组和起名是模型的事（它刚从看画布读到同批、提示词和时间）。坐标是这里算的绝对值：
 * 画布只负责打补丁，同一条结果重放多少次位置都一样。
 */
export const arrangeCanvas = defineAgentTool({
  name: 'arrangeCanvas',
  modes: ['image', 'video'],
  label: '整理画布',
  description:
    '把用户此刻看见的画布图片按你给的分组收成格子，并给每张或每一组写上页签。不生成东西、不花积分，画面内容一个像素不变。' +
    '先看画布：那一份包含还没同步到服务端的图，张数以它报的「共 N 个元素」为准，不要只整理上一轮提到的几张。' +
    '同批 id、提示词摘要和位置够分组时不要逐张看图。元素 id 取自看画布的「元素 xxx」。没写进分组的元素留在原地。坐标不用给。',
  guidance: () =>
    '用户要整理画布时，先看画布再调一次整理画布。看画布列的是他屏幕上的全部图，包括还没上传完的；把要排的图片元素 id 都写进分组，不要只拿上一轮说过的那几张。按同批 id、提示词和时间分组；无名无提示词的那一堆只看一张缩略图，名字用在整堆上。',
  parameters,
  onError: 'continue',
  call: ({ groups }) => {
    const count = Array.isArray(groups)
      ? groups.reduce(
          (sum, group) => sum + (Array.isArray(group?.items) ? group.items.length : 0),
          0,
        )
      : 0
    return { title: count > 0 ? `整理画布：${count} 张` : '整理画布' }
  },
  execute: (context) => async (_toolCallId, params) => {
    const canvas = await loadAgentCanvas(context)
    if (!canvas)
      throw new AgentToolError(
        'invalid_params',
        '这一轮没有服务端画布可读（画布只在本地，或者用户没登录），没法整理。',
      )
    const { canvasEdit, text } = canvas.arrange(params.groups)
    return { content: [{ type: 'text', text }], details: { canvasEdit } }
  },
})
