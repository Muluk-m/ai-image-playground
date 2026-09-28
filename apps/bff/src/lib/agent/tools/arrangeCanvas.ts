import {
  type AgentCanvasEdit,
  type AgentCanvasEditPlan,
  type AgentCanvasSnapshot,
  ARRANGE_CAPTION_MAX,
  ARRANGE_MAX_ITEMS,
  ARRANGE_SECTION_MAX,
  type ArrangeBox,
  layoutCanvasArrange,
  type ProjectDocument,
  type ProjectElement,
} from '@image-playground/shared'
import { and, eq, isNull } from 'drizzle-orm'
import { Type } from 'typebox'
import { db, schema } from '../../../db/client'
import { defineAgentTool } from './adapter'
import { AgentToolError } from './errors'
import type { AgentToolContext } from './types'

const parameters = Type.Object({
  groups: Type.Array(
    Type.Object({
      label: Type.Optional(
        Type.String({
          maxLength: ARRANGE_SECTION_MAX,
          description: '这一组左上角的大页签，一组一行。每张都有自己的名字时可以不写。',
        }),
      ),
      columns: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 12,
          description: '这一组排成几列。不写就收成接近方形的格子。',
        }),
      ),
      items: Type.Array(
        Type.Object({
          elementId: Type.String({
            description: '要排进去的图片元素 id，取自看画布报出来的「元素 xxx」。不是图片 id。',
          }),
          caption: Type.Optional(
            Type.String({
              maxLength: ARRANGE_CAPTION_MAX,
              description: '贴在这张图上方的小页签。不写就保持它现在的名字。',
            }),
          ),
        }),
        { minItems: 1, maxItems: ARRANGE_MAX_ITEMS },
      ),
    }),
    { minItems: 1, maxItems: 20, description: '按阅读顺序。一组是一块格子，组与组左右分开。' },
  ),
})

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

function imageShift(
  canvas: AgentCanvasSnapshot | undefined,
  elementId: string,
): { dx: number; dy: number } {
  const element = canvas?.elements.find((one) => one.id === elementId)
  if (!element || element.type !== 'image') return { dx: 0, dy: 0 }
  return { dx: element.dx ?? 0, dy: element.dy ?? 0 }
}

/** 箭头和手绘没有外接矩形字段，用点列自己围一个，好让整理结果避开它们。 */
function boundsOf(element: ProjectElement): ArrangeBox | null {
  if (element.type === 'arrow' || element.type === 'freedraw') {
    const points = element.points
    if (points.length < 2) return null
    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    for (let index = 0; index < points.length; index += 2) {
      const x = points[index] ?? 0
      const y = points[index + 1] ?? 0
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
    }
    return {
      id: element.id,
      x: minX,
      y: minY,
      w: Math.max(0, maxX - minX),
      h: Math.max(0, maxY - minY),
    }
  }
  return { id: element.id, x: element.x, y: element.y, w: element.width, h: element.height }
}

/**
 * 按内容把画布上的图收成几块，并写上页签。不生成东西、不花积分。
 *
 * 分组和起名是模型的事（它刚从看画布读到同批、提示词和时间）。坐标是这里算的绝对值：
 * 画布只负责打补丁，同一条结果重放多少次位置都一样。
 */
export const arrangeCanvas = defineAgentTool({
  name: 'arrangeCanvas',
  modes: ['image', 'video'],
  label: '整理画布',
  description:
    '把用户此刻看见的画布图片按你给的分组收成格子，并给每张或每一组写上页签。不生成东西、不花积分，画面内容一个像素不变。' +
    '先看画布：那一份包含还没同步到服务端的图，张数以它报的「共 N 个元素」为准，不要只整理上一轮提到的几张。' +
    '同批 id、提示词摘要和位置够分组时不要逐张看图。元素 id 取自看画布的「元素 xxx」。没写进分组的元素留在原地。坐标不用给。',
  guidance: () =>
    '用户要整理画布时，先看画布再调一次整理画布。看画布列的是他屏幕上的全部图，包括还没上传完的；把要排的图片元素 id 都写进分组，不要只拿上一轮说过的那几张。按同批 id、提示词和时间分组；无名无提示词的那一堆只看一张缩略图，名字用在整堆上。',
  parameters,
  onError: 'continue',
  call: ({ groups }) => {
    const count = Array.isArray(groups)
      ? groups.reduce(
          (sum, group) => sum + (Array.isArray(group?.items) ? group.items.length : 0),
          0,
        )
      : 0
    return { title: count > 0 ? `整理画布：${count} 张` : '整理画布' }
  },
  execute: (context) => async (_toolCallId, params) => {
    const listed = params.groups.reduce((sum, group) => sum + group.items.length, 0)
    if (listed > ARRANGE_MAX_ITEMS)
      throw new AgentToolError(
        'invalid_params',
        `一次最多整理 ${ARRANGE_MAX_ITEMS} 张，这次有 ${listed} 张。请拆成几组先后整理。`,
      )

    const live = context.canvas
    if (live?.omitted)
      throw new AgentToolError(
        'invalid_params',
        `这张画布还有 ${live.omitted} 个元素没有进入目录，无法安全计算整理落点。请先缩小画布范围。`,
      )
    const document = live ? null : await loadDocument(context)
    if (!live && !document)
      throw new AgentToolError(
        'invalid_params',
        '这一轮没有服务端画布可读（画布只在本地，或者用户没登录），没法整理。',
      )
    const known = new Map(
      (live ? live.elements : (document?.elements ?? [])).map((element) => [
        element.id,
        element.type,
      ]),
    )
    const boxes: ArrangeBox[] = live
      ? live.elements.map((element) => ({
          id: element.id,
          x: element.x,
          y: element.y,
          w: element.width,
          h: element.height,
        }))
      : (document?.elements ?? []).flatMap((element) => {
          const box = boundsOf(element)
          return box ? [box] : []
        })
    const missing: string[] = []
    const unsupported: string[] = []
    const duplicate: string[] = []
    const seen = new Set<string>()
    const groups = params.groups.flatMap((group) => {
      const items = group.items.flatMap((item) => {
        if (seen.has(item.elementId)) {
          duplicate.push(item.elementId)
          return []
        }
        seen.add(item.elementId)
        const element = known.get(item.elementId)
        if (!element) {
          missing.push(item.elementId)
          return []
        }
        if (known.get(item.elementId) !== 'image') {
          unsupported.push(item.elementId)
          return []
        }
        return [{ elementId: item.elementId, ...(item.caption ? { caption: item.caption } : {}) }]
      })
      return items.length > 0
        ? [{ ...(group.label ? { label: group.label } : {}), columns: group.columns, items }]
        : []
    })
    const placements = layoutCanvasArrange(groups, boxes)
    const notes =
      (missing.length ? `这些元素 id 在画布上找不到：${missing.join('、')}。` : '') +
      (unsupported.length ? `这些对象不是图片，没有排进去：${unsupported.join('、')}。` : '') +
      (duplicate.length ? `这些元素写了不止一次，只排了第一次：${duplicate.join('、')}。` : '')
    if (placements.length === 0)
      throw new AgentToolError('invalid_params', `没有可以整理的图片。${notes}`)

    const canvasEdit: AgentCanvasEditPlan = {
      edits: placements.map((item): AgentCanvasEdit => {
        const shift = imageShift(context.canvas, item.elementId)
        return {
          elementId: item.elementId,
          x: item.x + shift.dx,
          y: item.y + shift.dy,
          ...(item.caption ? { name: item.caption } : {}),
          section: item.section,
        }
      }),
    }
    return {
      content: [
        {
          type: 'text',
          text: `已把 ${placements.length} 张图排好，页签写在图的上方。${notes}`,
        },
      ],
      details: { canvasEdit },
    }
  },
})
