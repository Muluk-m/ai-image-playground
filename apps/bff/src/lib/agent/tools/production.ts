import { Type } from 'typebox'
import { isCapabilityEnabled } from '../../capabilities'
import {
  proposeProductionEdit as proposeEdit,
  readProduction as readDocument,
  writeProduction as writeDocument,
} from '../production'
import { defineAgentTool } from './adapter'
import { AgentToolError } from './errors'

const contentSchema = Type.Object({
  title: Type.String({ maxLength: 200 }),
  setting: Type.String({ maxLength: 100000 }),
  outline: Type.String({ maxLength: 100000 }),
  scenes: Type.Array(
    Type.Object({
      id: Type.String({ minLength: 1, maxLength: 128 }),
      title: Type.String({ maxLength: 200 }),
      body: Type.String({ maxLength: 100000 }),
    }),
    { maxItems: 100 },
  ),
})
export const readProduction = defineAgentTool({
  name: 'readProduction',
  modes: ['image', 'video'],
  label: '读取剧本',
  description:
    '读取当前会话的制作文档。默认返回摘要和稳定场景身份；需要正文时指定 section。没有文档返回 null。',
  guidance: '视频创作先读取当前制作文档；缺少设定可澄清。文档与图片产物分开，不把剧本画成图片。',
  parameters: Type.Object({
    section: Type.Optional(
      Type.Union([
        Type.Literal('summary'),
        Type.Literal('all'),
        Type.Literal('setting'),
        Type.Literal('outline'),
        Type.Literal('scenes'),
        Type.Literal('characters'),
        Type.Literal('locations'),
        Type.Literal('shots'),
      ]),
    ),
  }),
  available: (_mode, audience) => isCapabilityEnabled('agent:production') && !!audience?.userId,
  onError: 'continue',
  call: () => ({ title: '读取剧本' }),
  execute: (context) => async (_id, args) => {
    if (!context.userId) throw new AgentToolError('authentication_required', '请先登录')
    const record = await readDocument(context.conversationId, context.userId)
    const document = record?.document
    const section = args.section ?? 'summary'
    const result = !document
      ? null
      : section === 'all'
        ? document
        : {
            id: document.id,
            revision: document.revision,
            title: document.content.title,
            ...(section === 'summary'
              ? {
                  setting: document.content.setting.slice(0, 500),
                  outline: document.content.outline.slice(0, 500),
                  scenes: document.content.scenes.map((s) => ({ id: s.id, title: s.title })),
                  characters:
                    document.content.characters?.map((character) => ({
                      id: character.id,
                      name: character.name,
                      looks: character.looks.map((look) => ({ id: look.id, name: look.name })),
                    })) ?? [],
                  locations:
                    document.content.locations?.map((location) => ({
                      id: location.id,
                      name: location.name,
                    })) ?? [],
                  shots: document.content.shots?.map((shot) => ({
                    id: shot.id,
                    description: shot.description.slice(0, 150),
                  })),
                }
              : { [section]: document.content[section] }),
          }
    return { content: [{ type: 'text', text: JSON.stringify(result) }], details: {} }
  },
})
export const writeProduction = defineAgentTool({
  name: 'writeProduction',
  modes: ['image', 'video'],
  label: '创建剧本',
  description:
    '把明确创作请求形成的第一份设定、大纲、分场正文保存到当前会话制作文档，显示在剧本面板。此工具仅创建第一版；现有稿件不可直接覆盖。',
  guidance:
    '创作剧本时先加载 video-production 技能；已有正文先读再提出修改，不用新建方式覆盖。未知内容留空，不捏造已确认条件。',
  parameters: Type.Object({ content: contentSchema }),
  available: (_mode, audience) => isCapabilityEnabled('agent:production') && !!audience?.userId,
  onError: 'continue',
  call: () => ({ title: '创建剧本' }),
  execute: (context) => async (toolCallId, args) => {
    if (!context.userId) throw new AgentToolError('authentication_required', '请先登录')
    const record = await writeDocument(
      context.conversationId,
      context.userId,
      {
        operationId: `tool:${context.turnId}:${toolCallId}`,
        baseRevision: 0,
        content: args.content,
      },
      'agent',
      context.turnId,
    )
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            documentId: record.document.id,
            revision: record.document.revision,
            title: record.document.content.title,
            saved: true,
          }),
        },
      ],
      details: {},
    }
  },
})

export const proposeProductionEdit = defineAgentTool({
  name: 'proposeProductionEdit',
  modes: ['image', 'video'],
  label: '建议修改剧本',
  description:
    '根据本轮冻结的文档选区或面板对象生成修改建议；不直接覆盖原稿。replacement 是选区替换文本，未划词时是当前单个字段的完整新正文。',
  guidance:
    '编辑已有剧本使用 proposeProductionEdit。只能修改本轮明确选中的字段或引用；没有目标先请用户选择，过期引用重新选择，建议须经采用才生效。',
  parameters: Type.Object({
    replacement: Type.String({ maxLength: 100000 }),
    requestQuote: Type.String({ minLength: 1, maxLength: 2000 }),
  }),
  available: (_mode, audience) => isCapabilityEnabled('agent:production') && !!audience?.userId,
  onError: 'continue',
  call: () => ({ title: '建议修改剧本' }),
  execute: (context) => async (toolCallId, args) => {
    if (!context.userId) throw new AgentToolError('authentication_required', '请先登录')
    if (!context.params?.production)
      throw new AgentToolError(
        'invalid_params',
        '请先在剧本面板选择要修改的内容或引用文字。不能将宽泛请求解释成改写全部文档。',
      )
    if (
      !args.requestQuote.trim() ||
      !context.authorization?.().instructions.includes(args.requestQuote)
    )
      throw new AgentToolError('invalid_params', 'requestQuote 必须是本轮用户要求的原文片段。')
    const proposal = await proposeEdit(
      context.conversationId,
      context.userId,
      context.params.production,
      args.replacement,
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
            before: proposal.before,
            after: proposal.after,
            status: proposal.status,
            message: '建议已保存，用户采用前原文不变。',
          }),
        },
      ],
      details: {},
    }
  },
})
