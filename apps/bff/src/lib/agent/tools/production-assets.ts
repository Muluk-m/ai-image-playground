import { Type } from 'typebox'
import { isCapabilityEnabled } from '../../capabilities'
import { proposeProductionAssets as proposeAssets } from '../production-assets'
import { defineAgentTool } from './adapter'
import { AgentToolError } from './errors'

const id = Type.String({ minLength: 1, maxLength: 128 })
const reference = Type.Union([
  Type.Object({ kind: Type.Literal('media'), mediaId: id }),
  Type.Object({ kind: Type.Literal('artifact'), artifactId: id }),
  Type.Object({ kind: Type.Literal('asset'), imageId: id }),
])
const entity = {
  id,
  name: Type.String({ maxLength: 200 }),
  description: Type.String({ maxLength: 10000 }),
}
const look = Type.Object({ ...entity, reference: Type.Optional(reference) })
export const proposeProductionAssets = defineAgentTool({
  name: 'proposeProductionAssets',
  modes: ['image', 'video'],
  label: '提取角色与场景',
  description:
    '从当前剧本整理角色、同一角色的不同造型和场景，保存为待用户采用的建议。完整返回需要保留的角色和场景；建议不会直接覆盖文稿。',
  guidance:
    '先读取文稿及已有角色/场景，沿用稳定 id；换装添加同一角色下的造型，改名或排序不能新造身份。图片引用只能使用实际已授权对象，不编造引用。',
  parameters: Type.Object({
    baseRevision: Type.Integer({ minimum: 1 }),
    characters: Type.Array(Type.Object({ ...entity, looks: Type.Array(look, { maxItems: 100 }) }), {
      maxItems: 100,
    }),
    locations: Type.Array(look, { maxItems: 100 }),
    requestQuote: Type.String({ minLength: 1, maxLength: 2000 }),
  }),
  available: (_mode, audience) => isCapabilityEnabled('agent:production') && !!audience?.userId,
  onError: 'continue',
  call: () => ({ title: '提取角色与场景' }),
  execute: (context) => async (toolCallId, args) => {
    if (!context.userId) throw new AgentToolError('authentication_required', '请先登录')
    if (
      !args.requestQuote.trim() ||
      !context.authorization?.().instructions.includes(args.requestQuote)
    )
      throw new AgentToolError('invalid_params', 'requestQuote 必须是本轮用户要求的原文片段。')
    const proposal = await proposeAssets(
      context.conversationId,
      context.userId,
      { baseRevision: args.baseRevision, characters: args.characters, locations: args.locations },
      context.turnId,
      `${context.turnId}:${toolCallId}`,
    )
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            proposalId: proposal.id,
            baseRevision: proposal.baseRevision,
            characters: proposal.characters,
            locations: proposal.locations,
            status: proposal.status,
            message: '提取建议已保存，用户采用前文稿不变。',
          }),
        },
      ],
      details: {},
    }
  },
})
