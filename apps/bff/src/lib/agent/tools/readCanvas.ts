import { ARRANGE_MAX_ITEMS, agentTitleLine } from '@image-playground/shared'
import { Type } from 'typebox'
import { loadAgentCanvas } from '../canvas-view'
import { defineAgentTool } from './adapter'

const TITLE_MAX_CHARS = 24
const DEFAULT_LIMIT = ARRANGE_MAX_ITEMS
const MAX_LIMIT = ARRANGE_MAX_ITEMS

const parameters = Type.Object({
  query: Type.Optional(
    Type.String({ description: '按图片名或文字内容里的关键词筛，留空就看整张画布。' }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_LIMIT,
      description: `最多列几个元素，默认 ${DEFAULT_LIMIT}。`,
    }),
  ),
  offset: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 1000,
      description: '从第几个命中元素开始列，超过一页时用它看下一批。',
    }),
  ),
})

export const readCanvas = defineAgentTool({
  name: 'readCanvas',
  modes: ['image', 'video'],
  label: '看画布',
  description:
    '看用户发话时屏幕上的画布：每个元素的类型、位置、尺寸，图片还给同批 id、创建时间和提示词摘要。还没同步到服务端的图也在里面，张数以「共 N 个元素」为准。超过一页时用 offset 继续读。元素 id 与图片 id 不同，只有图片 id 能交给 viewImage 或 editImage。',
  guidance:
    '用户指着画布上的东西说话，或要整理画布时，先看画布；提示还有未展开元素时按 offset 继续，直到读完。目录注明有元素没带上时不要声称看全或整理全画布。同批 id、提示词和位置用于分组；无法识别的一组看一张缩略图。',
  parameters,
  onError: 'continue',
  // 读画布不落画布，也没有送进上游的提示词，所以起跑时只有一行标题。
  call: ({ query }) => ({
    title:
      typeof query === 'string' && query.trim()
        ? `看画布：${agentTitleLine(query, TITLE_MAX_CHARS)}`
        : '看画布',
  }),
  execute: (context) => async (_toolCallId, params) => {
    const canvas = await loadAgentCanvas(context)
    return {
      content: [
        {
          type: 'text',
          text:
            canvas?.describe(params) ??
            '这一轮没有服务端画布可读（画布只在本地，或者用户没登录）。',
        },
      ],
      details: {},
    }
  },
})
