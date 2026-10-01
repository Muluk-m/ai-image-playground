import { Type } from 'typebox'
import { isCapabilityEnabled } from '../../capabilities'
import { readProduction as readDocument, writeProduction as writeDocument } from '../production'
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
