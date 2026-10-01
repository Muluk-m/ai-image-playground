import { Type } from 'typebox'
import { batchPlansAvailable, createAgentBatchPlan } from '../batch-plans'
import { defineAgentTool } from './adapter'

export const planImageBatch = defineAgentTool({
  name: 'planImageBatch',
  modes: ['image'],
  label: '批次计划',
  description:
    '针对固定的一组图片拟定逐项编辑计划，保存统一规则、完整范围与每项提示词供用户审查。只保存草稿，不生成、不提交任务。不同图片各列一项，不能用同一输入的产物数代替。',
  guidance:
    '用户要求批量处理时，用 planImageBatch 展示固定范围与逐项提示词；必须列齐用户要求的输入，不可静默漏图。当前只支持计划审查，不可宣称已开始生成。无法准备完整输入时先明确说明。',
  onError: 'continue',
  available: (_mode, audience) => batchPlansAvailable(audience),
  parameters: Type.Object({
    title: Type.String({ minLength: 1, maxLength: 120 }),
    rule: Type.String({ minLength: 1, maxLength: 4000 }),
    items: Type.Array(
      Type.Object({
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
          text: `批次计划已保存，编号 ${batchId}。用户可以审查完整范围和逐项提示词。这次没有提交生成任务；生成执行尚未开放。`,
        },
      ],
      details: { batchId },
    }
  },
})
