import { Type } from 'typebox'
import { isCapabilityEnabled } from '../../capabilities'
import { batchExecutionAvailable } from '../batch-execution'
import { proposeBatchGeneration as saveGenerationProposal } from '../batch-generation-proposal'
import { readAgentBatchPlan } from '../batch-plans'
import { defineAgentTool } from './adapter'
import { AgentToolError } from './errors'
import { resolveAgentModel } from './queueTask'

export const proposeBatchGeneration = defineAgentTool({
  name: 'proposeBatchGeneration',
  modes: ['image'],
  label: '确认生成计划',
  description:
    '依据同一批次已经真实完成的分析，拟定逐项完整生成提示词并重新报价。只保存新阶段，必须由用户再次确认生成。',
  guidance:
    '先读取分析结果，再为每项写出完整且具体的生成提示词，sourceItemKeys列出真实分析来源。不可用占位提示词提前授权。未完成或未知分析不能作为成功证据；用户选择缩小范围时必须明确excludedItemKeys和excludedImageIds，旧核查仍保留。',
  onError: 'continue',
  available: (_mode, audience) =>
    Boolean(
      audience?.userId &&
        batchExecutionAvailable(audience.userId) &&
        isCapabilityEnabled('agent:batch-analysis'),
    ),
  parameters: Type.Object({
    batchId: Type.String({ minLength: 1, maxLength: 128 }),
    expectedVersion: Type.Integer({ minimum: 1 }),
    excludedItemKeys: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 100 }),
    ),
    excludedImageIds: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 100 }),
    ),
    items: Type.Array(
      Type.Object({
        key: Type.String({ minLength: 1, maxLength: 128 }),
        inputImageIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
          minItems: 1,
          maxItems: 100,
        }),
        sourceItemKeys: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
          minItems: 1,
          maxItems: 100,
        }),
        prompt: Type.String({ minLength: 1, maxLength: 4000 }),
        model: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      }),
      { minItems: 1, maxItems: 100 },
    ),
  }),
  call: () => ({ title: '依据分析拟定生成计划' }),
  execute: (context) => async (toolCallId, input) => {
    if (!context.userId) throw new AgentToolError('invalid_params', '请登录后确认生成计划。')
    const current = await readAgentBatchPlan(context.userId, input.batchId, { limit: 1 })
    if (!current || current.batch.conversationId !== context.conversationId)
      throw new AgentToolError('invalid_params', '没有找到当前对话的批次。')
    const { autoSubmit: _autoSubmit, ...params } = context.params ?? {}
    await saveGenerationProposal(context.userId, input.batchId, {
      commandId: `agent:${context.turnId}:${toolCallId}`,
      expectedVersion: input.expectedVersion,
      excludedItemKeys: input.excludedItemKeys,
      excludedImageIds: input.excludedImageIds,
      items: input.items.map((item) => {
        const target = resolveAgentModel('image', item.model ?? context.params?.model)
        if (!target) throw new AgentToolError('model_unavailable', '暂时没有可用的生图模型。')
        return {
          key: item.key,
          inputImageIds: item.inputImageIds,
          sourceItemKeys: item.sourceItemKeys,
          prompt: item.prompt,
          params: { ...params, ...target },
        }
      }),
    })
    return {
      content: [
        {
          type: 'text',
          text: '已根据真实分析保存逐项生成提示词和新报价。请用户审查范围、排除项和提示词后确认生成。',
        },
      ],
      details: { batchId: input.batchId },
    }
  },
})
