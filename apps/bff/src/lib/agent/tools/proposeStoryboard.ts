import { PRODUCTION_SHOTS_MAX } from '@image-playground/shared'
import { Type } from 'typebox'
import { isCapabilityEnabled } from '../../capabilities'
import { proposeProductionStoryboard } from '../production-storyboard'
import { defineAgentTool } from './adapter'
import { AgentToolError } from './errors'

const keyframeSchema = Type.Union([
  Type.Object({ kind: Type.Literal('media'), mediaId: Type.String({ maxLength: 128 }) }),
  Type.Object({ kind: Type.Literal('artifact'), artifactId: Type.String({ maxLength: 128 }) }),
  Type.Object({ kind: Type.Literal('asset'), imageId: Type.String({ maxLength: 128 }) }),
])

export const proposeStoryboard = defineAgentTool({
  name: 'proposeStoryboard',
  modes: ['image', 'video'],
  label: '建议分镜',
  description:
    '把已保存的剧本转换为镜头条目建议，用户采用后生效。已有分镜的修改只限本轮选中的分镜或镜头。镜头id稳定且独立于排序；预计时长不是模型生成参数。',
  guidance:
    '先读取制作文档，再按剧本提出分镜。沿用已有角色造型/场景身份，不编造引用。未知对白、景别和时长可以省略，不把推测标为已确认；拟好分镜不是已生成视频。',
  parameters: Type.Object({
    baseRevision: Type.Integer({ minimum: 1 }),
    requestQuote: Type.String({ minLength: 1, maxLength: 2000 }),
    shots: Type.Array(
      Type.Object({
        id: Type.String({ minLength: 1, maxLength: 128 }),
        scriptSceneId: Type.Optional(Type.String({ maxLength: 128 })),
        locationId: Type.Optional(Type.String({ maxLength: 128 })),
        lookIds: Type.Array(Type.String({ maxLength: 128 }), { maxItems: 30 }),
        keyframe: Type.Optional(keyframeSchema),
        description: Type.String({ maxLength: 10000 }),
        dialogue: Type.Optional(Type.String({ maxLength: 10000 })),
        camera: Type.Optional(Type.String({ maxLength: 10000 })),
        durationSeconds: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
      }),
      { maxItems: PRODUCTION_SHOTS_MAX },
    ),
  }),
  available: (_mode, audience) => isCapabilityEnabled('agent:production') && !!audience?.userId,
  onError: 'continue',
  call: () => ({ title: '建议分镜' }),
  execute: (context) => async (toolCallId, args) => {
    if (!context.userId) throw new AgentToolError('authentication_required', '请先登录')
    if (
      !args.requestQuote.trim() ||
      !context.authorization?.().instructions.includes(args.requestQuote)
    )
      throw new AgentToolError('invalid_params', '请引用本轮用户提出分镜要求的原文。')
    const proposal = await proposeProductionStoryboard(
      context.conversationId,
      context.userId,
      args,
      context.turnId,
      `${context.turnId}:${toolCallId}`,
      context.params?.production,
    )
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            proposalId: proposal.id,
            shots: proposal.shots,
            status: 'pending',
            message: '分镜建议已保存，等待用户采用。',
          }),
        },
      ],
      details: {},
    }
  },
})
