import { Type } from 'typebox'
import { config } from '../../../config'
import { db } from '../../../db/client'
import { isCapabilityEnabled } from '../../capabilities'
import { proposeBatchAnalysis as saveAnalysisProposal } from '../batch-analysis-proposal'
import { readBatchSourceItems } from '../batch-analysis-sources'
import { batchExecutionAvailable } from '../batch-execution'
import { readAgentBatchPlan, sameArchivedReference } from '../batch-plans'
import { defineAgentTool } from './adapter'
import { AgentToolError } from './errors'

export const proposeBatchAnalysis = defineAgentTool({
  name: 'proposeBatchAnalysis',
  modes: ['image'],
  label: '补看分析计划',
  description:
    '为同一批次的已选图片追加明确的逐图检查或联合比较，保存新版本和独立报价。只拟计划，用户确认前不调用模型、不预扣分析费用。',
  guidance:
    '需要补看细节或联合比较时使用此工具。先读现有分析，说明新增检查范围与目的；必须指定现有批次和版本，不能重发旧任务、隐式扩大已确认范围或冒充已完成检查。新报价必须由用户显式确认。',
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
    items: Type.Array(
      Type.Object({
        key: Type.String({ minLength: 1, maxLength: 128 }),
        imageIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
          minItems: 1,
          maxItems: 100,
        }),
        prompt: Type.String({ minLength: 1, maxLength: 4000 }),
        dependencies: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 100 }),
        model: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        intent: Type.Optional(
          Type.Union([Type.Literal('inspection'), Type.Literal('joint_comparison')]),
        ),
      }),
      { minItems: 1, maxItems: 100 },
    ),
  }),
  call: () => ({ title: '拟定补看范围与报价' }),
  execute: (context) => async (toolCallId, input) => {
    if (!context.userId) throw new AgentToolError('invalid_params', '请登录后拟定补看计划。')
    const current = await readAgentBatchPlan(context.userId, input.batchId, { limit: 100 })
    if (
      !current ||
      current.batch.conversationId !== context.conversationId ||
      current.batch.version !== input.expectedVersion
    )
      throw new AgentToolError('invalid_params', '没有找到当前对话的批次版本，请重新读取计划。')
    const sources = await readBatchSourceItems(
      db,
      input.batchId,
      current.batch.confirmation?.sourceVersions ?? [],
    )
    const references = [...current.items, ...sources.map((source) => source.item)].flatMap(
      (item) => item.inputs,
    )
    try {
      await saveAnalysisProposal(context.userId, input.batchId, {
        commandId: `agent:${context.turnId}:${toolCallId}`,
        expectedVersion: input.expectedVersion,
        items: input.items.map((item) => ({
          key: item.key,
          prompt: item.prompt,
          dependencies: item.dependencies,
          params: { model: item.model ?? config.agent.model, intent: item.intent },
          inputs: item.imageIds.map((imageId) => {
            const matches = references.filter((reference) => reference.imageId === imageId)
            const reference = matches[0]
            if (
              !reference ||
              matches.some((candidate) => !sameArchivedReference(reference, candidate))
            )
              throw new AgentToolError(
                'invalid_params',
                '补看图片必须明确对应当前批次的已选原件与选区。',
              )
            return reference
          }),
        })),
      })
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'batch_source_limit_exceeded')
        throw new AgentToolError(
          'invalid_params',
          '该批次已达到可保留分析来源版本上限，请新建批次并重新明确检查范围。已有分析、账单与核查任务均保留。',
        )
      throw error
    }
    return {
      content: [
        {
          type: 'text',
          text: '已保存补看范围、具体检查提示词和新报价。尚未开始新增分析，请用户审查后确认分析。',
        },
      ],
      details: { batchId: input.batchId },
    }
  },
})
