import { Type } from 'typebox'
import { batchExecutionAvailable } from '../batch-execution'
import { batchPlansAvailable, createAgentBatchPlan } from '../batch-plans'
import { defineAgentTool } from './adapter'

export const planImageBatch = defineAgentTool({
  name: 'planImageBatch',
  modes: ['image'],
  label: '批次计划',
  description:
    '针对固定的一组图片拟定分析或编辑计划，保存统一规则、完整范围与每项提示词供用户审查和确认报价。调用只保存草稿。analysis 项检查或比较图片，generation 项生成图片；不同处理目标各列一项。',
  guidance:
    '用户要求批量处理时，用 planImageBatch 展示固定范围与逐项提示词；必须列齐用户要求的输入，不可静默漏图。计划保存后等待用户确认报价，不可宣称已开始执行。analysis 仅在分析能力开放时使用。联合比较必须单列 intent=joint_comparison 的 analysis 项，把需要比较的原图放在同一次调用；逐图检查使用 inspection。无法准备完整输入时先明确说明，不得用逐图检查代替联合比较。',
  onError: 'continue',
  available: (_mode, audience) => batchPlansAvailable(audience),
  parameters: Type.Object({
    title: Type.String({ minLength: 1, maxLength: 120 }),
    rule: Type.String({ minLength: 1, maxLength: 4000 }),
    items: Type.Array(
      Type.Object({
        intent: Type.Optional(
          Type.Union([Type.Literal('inspection'), Type.Literal('joint_comparison')]),
        ),
        kind: Type.Optional(Type.Union([Type.Literal('generation'), Type.Literal('analysis')])),
        key: Type.String({ minLength: 1, maxLength: 128 }),
        imageIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
          minItems: 1,
          maxItems: 100,
        }),
        prompt: Type.String({ minLength: 1, maxLength: 4000 }),
        dependencies: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 100 }),
      }),
      { minItems: 1, maxItems: 100 },
    ),
  }),
  call: ({ title }) => ({ title: typeof title === 'string' ? title : '批次计划' }),
  execute: (context) => async (toolCallId, params) => {
    const batchId = await createAgentBatchPlan(context, toolCallId, params)
    return {
      content: [
        {
          type: 'text',
          text: `批次计划已保存，编号 ${batchId}。${context.userId && batchExecutionAvailable(context.userId) ? '等待用户审查完整范围、逐项提示词和报价，再确认执行。' : '当前仅开放草稿审查，执行暂未开放。'}`,
        },
      ],
      details: { batchId },
    }
  },
})
