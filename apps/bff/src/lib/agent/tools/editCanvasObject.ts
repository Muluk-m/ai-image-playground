import {
  AGENT_CANVAS_EDIT_MAX,
  AGENT_CANVAS_NAME_MAX_CHARS,
  type AgentCanvasEdit,
  type AgentCanvasEditPlan,
  type ProjectDocument,
} from '@image-playground/shared'
import { and, eq, isNull } from 'drizzle-orm'
import { Type } from 'typebox'
import { db, schema } from '../../../db/client'
import { defineAgentTool } from './adapter'
import { AgentToolError } from './errors'
import type { AgentToolContext } from './types'

const parameters = Type.Object({
  edits: Type.Array(
    Type.Object({
      elementId: Type.String({
        description: '要改的画布元素 id，取自看画布报出来的「元素 xxx」。不是图片 id。',
      }),
      name: Type.Optional(
        Type.String({
          maxLength: AGENT_CANVAS_NAME_MAX_CHARS,
          description: '新名称。不想改名就不要给这一项。',
        }),
      ),
      x: Type.Optional(Type.Number({ description: '新的左上角横坐标（绝对值）。' })),
      y: Type.Optional(Type.Number({ description: '新的左上角纵坐标（绝对值）。' })),
      width: Type.Optional(Type.Number({ description: '新的显示宽度（绝对值，> 0）。' })),
      height: Type.Optional(Type.Number({ description: '新的显示高度（绝对值，> 0）。' })),
    }),
    { minItems: 1, maxItems: AGENT_CANVAS_EDIT_MAX },
  ),
})

/**
 * 服务端那份画布文档，用来在发给前端之前核一遍元素 id。
 * 与 `readCanvas` 同一条读法：没登录的设备在服务端根本没有画布（它只在浏览器里）。
 */
async function loadDocument(context: AgentToolContext): Promise<ProjectDocument | null> {
  if (!context.userId) return null
  const [row] = await db
    .select({ document: schema.canvas_projects.document })
    .from(schema.canvas_projects)
    .where(
      and(
        eq(schema.canvas_projects.conversation_id, context.conversationId),
        eq(schema.canvas_projects.user_id, context.userId),
        isNull(schema.canvas_projects.deleted_at),
      ),
    )
    .limit(1)
  return row?.document ?? null
}

/** 这条改动落到哪个元素上：只有图片对象能改。 */
type Verdict = 'ok' | 'missing' | 'unsupported'

function verdict(document: ProjectDocument | null, elementId: string): Verdict {
  // 服务端没有这份画布（没登录）时不假装校验：交给前端的画布去认，它才是真身。
  if (!document) return 'ok'
  const element = document.elements.find((one) => one.id === elementId)
  if (!element) return 'missing'
  // 生成占位与产物由服务端登记，客户端改一个字整份保存都会被拒（projects.ts 的逐字核对）。
  return element.type === 'image' ? 'ok' : 'unsupported'
}

/** 只留真的要改的那几项；一条改动什么都没带就不是改动。 */
function edit(one: {
  elementId: string
  name?: string
  x?: number
  y?: number
  width?: number
  height?: number
}): AgentCanvasEdit | null {
  const patch: AgentCanvasEdit = {
    elementId: one.elementId,
    ...(one.name !== undefined ? { name: one.name.trim() } : {}),
    ...(Number.isFinite(one.x) ? { x: one.x } : {}),
    ...(Number.isFinite(one.y) ? { y: one.y } : {}),
    // 宽高是显示尺寸，0 与负数在画布上没有意义，按「没给」处理而不是写进去。
    ...(Number.isFinite(one.width) && (one.width ?? 0) > 0 ? { width: one.width } : {}),
    ...(Number.isFinite(one.height) && (one.height ?? 0) > 0 ? { height: one.height } : {}),
  }
  return Object.keys(patch).length > 1 ? patch : null
}

/**
 * 改画布上已有对象的属性：改名、挪位置、改显示尺寸。**不生成任何东西、不花积分。**
 *
 * 与 `arrangeTimeline` 同一条路子：服务端只算出一份改动计划，真正落地由浏览器里的画布
 * 执行（`AgentCanvasSink.editElements`）。理由有两条——
 * 一是几何改动必须作用在用户此刻看到的那份画布上，服务端那份可能还没同步到；
 * 二是没登录的用户在服务端没有画布，走服务端直写这条对他们完全失效。
 */
export const editCanvasObject = defineAgentTool({
  name: 'editCanvasObject',
  modes: ['image', 'video'],
  label: '改画布对象',
  description:
    '改画布上已有对象的名称、位置或显示尺寸。不生成东西、不花积分，画面内容一个像素不变。' +
    '元素 id 取自看画布报出的「元素 xxx」，不是图片 id。要改画面内容用改图工具。',
  guidance: () =>
    '用户要给画布上的东西改名、挪位置、改大小时，先看画布拿元素 id，再用改画布对象工具一次提交；坐标与尺寸都给绝对值。',
  parameters,
  onError: 'continue',
  // 不落图、不占位：改的是已有对象，没有新产物。
  call: ({ edits }) => ({
    title: Array.isArray(edits) ? `改画布对象：${edits.length} 个` : '改画布对象',
  }),
  execute: (context) => async (_toolCallId, params) => {
    const document = await loadDocument(context)
    const applied: AgentCanvasEdit[] = []
    const missing: string[] = []
    const unsupported: string[] = []
    const empty: string[] = []
    for (const one of params.edits) {
      const decided = verdict(document, one.elementId)
      if (decided === 'missing') {
        missing.push(one.elementId)
        continue
      }
      if (decided === 'unsupported') {
        unsupported.push(one.elementId)
        continue
      }
      const patch = edit(one)
      if (patch) applied.push(patch)
      else empty.push(one.elementId)
    }

    const notes =
      (missing.length ? `这些元素 id 在画布上找不到：${missing.join('、')}。` : '') +
      (unsupported.length
        ? `这些对象不是图片，改不了名称与尺寸：${unsupported.join('、')}。`
        : '') +
      (empty.length ? `这些条目没写任何要改的属性，跳过了：${empty.join('、')}。` : '')

    // 一条都改不了时明确失败，别回一句「改好了」让模型以为成了。
    if (applied.length === 0)
      throw new AgentToolError('invalid_params', `没有可以改的对象。${notes}`)

    const canvasEdit: AgentCanvasEditPlan = { edits: applied }
    return {
      content: [
        {
          type: 'text',
          text: `已改好画布上 ${applied.length} 个对象。${notes}`,
        },
      ],
      details: { canvasEdit },
    }
  },
})
