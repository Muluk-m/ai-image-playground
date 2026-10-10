import { Type } from 'typebox'
import { readConversationImageCatalog } from '../conversation-images'
import { defineAgentTool } from './adapter'
import { AgentToolError } from './errors'

export const readConversationImages = defineAgentTool({
  name: 'readConversationImages',
  modes: ['image', 'video'],
  label: '查会话图片',
  description:
    '查询当前会话曾上传和生成的图片，返回稳定图片 ID、来源轮次、时间、名称、原始提示词摘要及可用状态，不读取像素。用户提到之前的图、图片 ID 不在当前上下文时调用；历史压缩后仍可查询。只查询当前会话，不代表用户授权处理全部历史图片。nextCursor 有值表示还有下一页。',
  guidance:
    '用户指代之前的图片且当前上下文无法确定完整范围时，先查会话图片；按来源轮次、时间和原始提示词找到对应图片。需要辨认内容时再用 viewImage 看图；可用图片 ID 可直接交给 editImage 或 planImageBatch。还有 nextCursor 时按需翻页，不得把一页当全部。',
  available: (_mode, audience) => Boolean(audience?.userId),
  parameters: Type.Object({
    query: Type.Optional(
      Type.String({
        maxLength: 200,
        description: '按附件名称或原始提示词筛选，省略列最近图片；不是图片内容的语义搜索。',
      }),
    ),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 50, description: '每页最多几张，默认 20。' }),
    ),
    cursor: Type.Optional(
      Type.String({
        maxLength: 500,
        description: '上一页返回的 nextCursor；继续翻页时保持相同 query。',
      }),
    ),
  }),
  onError: 'continue',
  call: () => ({ title: '查会话图片' }),
  execute: (context) => async (_toolCallId, params) => {
    if (!context.userId) throw new AgentToolError('invalid_params', '请登录后查询会话图片。')
    const catalog = await readConversationImageCatalog({
      conversationId: context.conversationId,
      userId: context.userId,
      query: params.query,
      cursor: params.cursor,
      limit: params.limit ?? 20,
    })
    return { content: [{ type: 'text', text: JSON.stringify(catalog) }], details: {} }
  },
})
