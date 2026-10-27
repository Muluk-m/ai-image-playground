import { Type } from 'typebox'
import { BatchAnalysisLimit } from '../batch-analysis-limit'
import { batchExecutionAvailable } from '../batch-execution'
import { batchPlansAvailable, createAgentBatchPlan } from '../batch-plans'
import { defineAgentTool } from './adapter'
import { AgentToolError } from './errors'
import { aspectRatioParameter } from './queueParams'

export const planImageBatch = defineAgentTool({
  name: 'planImageBatch',
  modes: ['image'],
  label: '批次计划',
  description:
    '拟定批量生图或图片分析计划，保存统一规则、完整范围与每项提示词供用户审查和确认报价。调用只保存草稿。generation 项生成图片：基于已有图片时 imageIds 填对应图片，纯文字生图（系列图、多张不同场景等）时 imageIds 传空数组；analysis 项检查或比较图片，必须带图片。不同处理目标各列一项。超过 8 项时分多次保存，每次不超过 8 项。',
  guidance:
    '用户要求批量处理对话中的图片，或要求先出计划卡/批量计划再生成多张图时，用 planImageBatch 展示固定范围与逐项提示词；没有参考图的纯文字需求同样可以出计划卡，generation 项的 imageIds 传空数组，不得以没有图片为由拒绝出卡。有参考图时必须列齐用户要求的输入，不可静默漏图。超过 8 项时分多次保存，每次不超过 8 项。分多次保存时各次的项编号不重复；要重做本轮已保存的计划时沿用原项编号并列齐全部项，旧计划会自动作废。title 与 rule 不写张数或项数。计划保存后等待用户确认报价，不可宣称已开始执行。analysis 仅在分析能力开放时使用。联合比较必须单列 intent=joint_comparison 的 analysis 项，把需要比较的原图放在同一次调用；逐图检查使用 inspection。无法准备完整输入时先明确说明，不得用逐图检查代替联合比较。',
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
        // 纯文字生图的 generation 项没有输入图（BUG-25）；analysis 项在保存时仍要求至少一张。
        imageIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
          minItems: 0,
          maxItems: 100,
        }),
        prompt: Type.String({ minLength: 1, maxLength: 4000 }),
        dependencies: Type.Optional(
          Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 100 }),
        ),
        aspectRatio: aspectRatioParameter,
      }),
      { minItems: 1, maxItems: 100 },
    ),
  }),
  call: ({ title }) => ({ title: typeof title === 'string' ? title : '批次计划' }),
  execute: (context) => async (toolCallId, params) => {
    // 节点画布的生成要绑到目标节点上，通用批次的结果落不回节点。
    if (context.experience === 'canvas' && params.items.some((item) => item.kind !== 'analysis'))
      throw new AgentToolError(
        'invalid_params',
        '节点画布中的生成不能使用批次计划。请用 createNodes 或 updateNodes 准备节点，再用 runNodes 指定要运行的节点。',
      )
    let batchId: string
    try {
      batchId = await createAgentBatchPlan(context, toolCallId, params)
    } catch (error) {
      if (!(error instanceof BatchAnalysisLimit)) throw error
      return {
        content: [{ type: 'text', text: error.message }],
        details: { analysisLimit: error.details },
      }
    }
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
