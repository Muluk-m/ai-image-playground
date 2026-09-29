import {
  type AgentCanvasEdit,
  type AgentCanvasEditPlan,
  type AgentCanvasLiveElement,
  ARRANGE_MAX_ITEMS,
  type ArrangeBox,
  type ArrangeGroupInput,
  layoutCanvasArrange,
  type ProjectDocument,
  type ProjectElement,
  projectArtifactId,
} from '@image-playground/shared'
import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { AgentToolError } from './tools/errors'
import type { AgentToolContext } from './tools/types'

const TEXT_PREVIEW_CHARS = 80

/**
 * 画布是按用户存的（`canvas_projects.user_id` 非空），没登录的设备在服务端根本没有画布——
 * 它的画布只在浏览器里。所以这里没登录就是没有，不要为「设备也能查」加分支。
 *
 * 会话与项目是一对一的（`idx_canvas_projects_conversation`），归属再核一次 user_id：
 * conversationId 是这一轮的真身不假，但多一条限定不花钱，读错别人画布的代价却兜不住。
 */
async function loadDocument(
  context: AgentToolContext,
): Promise<{ document: ProjectDocument; revision: number } | null> {
  if (!context.userId) return null
  const [row] = await db
    .select({
      document: schema.canvas_projects.document,
      revision: schema.canvas_projects.revision,
    })
    .from(schema.canvas_projects)
    .where(
      and(
        eq(schema.canvas_projects.conversation_id, context.conversationId),
        eq(schema.canvas_projects.user_id, context.userId),
        // 进了回收站的画布用户自己都看不见，模型更不该从这里把它读回来。
        isNull(schema.canvas_projects.deleted_at),
      ),
    )
    .limit(1)
  return row?.document ? { document: row.document, revision: row.revision } : null
}

function box(element: { x: number; y: number; width: number; height: number }): string {
  return `位置 (${Math.round(element.x)}, ${Math.round(element.y)})，尺寸 ${Math.round(element.width)}×${Math.round(element.height)}`
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > TEXT_PREVIEW_CHARS ? `${flat.slice(0, TEXT_PREVIEW_CHARS)}…` : flat
}

/**
 * 分组用的目录，不看像素。提示词只给开头：整段能到一万字，塞进目录就和逐张看图一样贵。
 * 用户原话优先于落在图上的那份生成提示词，两边都有时原话更接近他要的分类。
 */
function catalog(element: Extract<ProjectElement, { type: 'image' }>): string {
  const parts: string[] = []
  if (element.groupId) parts.push(`同批 ${element.groupId}`)
  if (element.createdAt !== undefined) parts.push(`时间 ${element.createdAt}`)
  const prompt = element.meta?.userPrompt?.trim() || element.meta?.prompt?.trim()
  if (prompt) parts.push(`提示词「${preview(prompt)}」`)
  const derived = element.video?.generation?.derivedFrom?.id
  if (derived) parts.push(`从元素 ${derived} 派生`)
  return parts.length > 0 ? `，${parts.join('，')}` : ''
}

/**
 * 每一行都要把「元素 id」和「图片 id」分开说。
 *
 * 画布上每个元素都有自己的 id，而能交给 editImage / viewImage 的只有图片 id：生成位是
 * `agent_<任务>_<下标>`，用户自己放的图是那串 media id。两者长得都像 id，不写明模型就会
 * 拿元素 id 去改图，换回一个「找不到这张图」。
 */
function describeElement(element: ProjectElement): string {
  const head = `元素 ${element.id}`
  switch (element.type) {
    case 'generation': {
      const imageId = projectArtifactId(element.generationId, element.position)
      const state = element.errorCode ? `生成失败（${element.errorCode}）` : '生成结果'
      return `${head}：${state}，图片 id ${imageId}，${box(element)}`
    }
    case 'image': {
      const name = element.name ? `「${element.name}」` : '未命名'
      const kind = element.video ? '视频（这里给的是封面）' : '图片'
      return `${head}：${kind}${name}，图片 id ${element.mediaId}，${box(element)}${catalog(element)}`
    }
    case 'text':
      return `${head}：文字「${preview(element.text)}」，位置 (${Math.round(element.x)}, ${Math.round(element.y)})`
    case 'arrow': {
      const [x1, y1, x2, y2] = element.points
      return `${head}：箭头，从 (${Math.round(x1)}, ${Math.round(y1)}) 指向 (${Math.round(x2)}, ${Math.round(y2)})`
    }
    case 'freedraw':
      return `${head}：手绘，${element.points.length / 2} 个点`
    case 'timeline': {
      const clips = element.clips
        .map(
          (clip) =>
            `${clip.elementId}（${clip.in}s 起${clip.out === undefined ? '' : `，到 ${clip.out}s`}）`,
        )
        .join('；')
      return `${head}：时间线，${element.clips.length} 段：${clips || '暂时是空的'}，${box(element)}`
    }
  }
}

function describeLiveElement(element: AgentCanvasLiveElement): string {
  const head = `元素 ${element.id}`
  const where = `位置 (${Math.round(element.x)}, ${Math.round(element.y)})，尺寸 ${Math.round(element.width)}×${Math.round(element.height)}`
  if (element.type === 'text') {
    const body = element.text ? `「${element.text}」` : ''
    return `${head}：文字${body}，${where}`
  }
  if (element.type !== 'image') return `${head}：图形，${where}`
  const image = element
  const kind = image.video ? '视频（这里给的是封面）' : '图片'
  const name = image.name ? `「${image.name}」` : '（未命名）'
  const parts = [`${kind}${name}`]
  if (image.mediaId) parts.push(`图片 id ${image.mediaId}`)
  parts.push(where)
  if (image.groupId) parts.push(`同批 ${image.groupId}`)
  if (image.createdAt !== undefined) parts.push(`时间 ${image.createdAt}`)
  if (image.prompt) parts.push(`提示词「${image.prompt}」`)
  if (image.section) parts.push(`组页签「${image.section}」`)
  if (image.derivedFrom) parts.push(`从元素 ${image.derivedFrom} 派生`)
  return `${head}：${parts.join('，')}`
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

/** 两种画布表示在入口归一化；工具只拿目录和编辑计划，不再解释来源。 */
interface CanvasEntry {
  readonly id: string
  readonly type: string
  readonly description: string
  readonly searchable: string
  readonly bounds: ArrangeBox | null
  readonly dx: number
  readonly dy: number
}

class AgentCanvasView {
  private readonly byId: Map<string, CanvasEntry>

  constructor(
    private readonly entries: readonly CanvasEntry[],
    private readonly heading: string,
    private readonly omitted = 0,
  ) {
    this.byId = new Map(entries.map((entry) => [entry.id, entry]))
  }

  describe(params: { query?: string; limit?: number; offset?: number }): string {
    const keyword = params.query?.trim().toLowerCase()
    const picked = keyword
      ? this.entries.filter((entry) => entry.searchable.includes(keyword))
      : this.entries
    const limit = Math.min(params.limit ?? ARRANGE_MAX_ITEMS, ARRANGE_MAX_ITEMS)
    const offset = params.offset ?? 0
    const shown = picked.slice(offset, offset + limit)
    const head = keyword ? `${this.heading}，关键词命中 ${picked.length} 个` : this.heading
    if (shown.length === 0) return `${head}：没有可列的元素。`
    const next = offset + shown.length
    const more =
      picked.length > next
        ? `\n（还有 ${picked.length - next} 个没展开；下次以 offset ${next} 继续）`
        : ''
    return `${head}：\n${shown.map((entry) => entry.description).join('\n')}${more}`
  }

  arrange(requested: readonly ArrangeGroupInput[]): {
    canvasEdit: AgentCanvasEditPlan
    text: string
  } {
    const listed = requested.reduce((sum, group) => sum + group.items.length, 0)
    if (listed > ARRANGE_MAX_ITEMS)
      throw new AgentToolError(
        'invalid_params',
        `一次最多整理 ${ARRANGE_MAX_ITEMS} 张，这次有 ${listed} 张。请拆成几组先后整理。`,
      )
    if (this.omitted)
      throw new AgentToolError(
        'invalid_params',
        `这张画布还有 ${this.omitted} 个元素没有进入目录，无法安全计算整理落点。请先缩小画布范围。`,
      )
    const missing: string[] = []
    const unsupported: string[] = []
    const duplicate: string[] = []
    const seen = new Set<string>()
    const groups = requested.flatMap((group) => {
      const items = group.items.flatMap((item) => {
        if (seen.has(item.elementId)) {
          duplicate.push(item.elementId)
          return []
        }
        seen.add(item.elementId)
        const element = this.byId.get(item.elementId)
        if (!element) {
          missing.push(item.elementId)
          return []
        }
        if (element.type !== 'image') {
          unsupported.push(item.elementId)
          return []
        }
        return [{ elementId: item.elementId, ...(item.caption ? { caption: item.caption } : {}) }]
      })
      return items.length > 0
        ? [{ ...(group.label ? { label: group.label } : {}), columns: group.columns, items }]
        : []
    })
    const placements = layoutCanvasArrange(
      groups,
      this.entries.flatMap((entry) => (entry.bounds ? [entry.bounds] : [])),
    )
    const notes =
      (missing.length ? `这些元素 id 在画布上找不到：${missing.join('、')}。` : '') +
      (unsupported.length ? `这些对象不是图片，没有排进去：${unsupported.join('、')}。` : '') +
      (duplicate.length ? `这些元素写了不止一次，只排了第一次：${duplicate.join('、')}。` : '')
    if (placements.length === 0)
      throw new AgentToolError('invalid_params', `没有可以整理的图片。${notes}`)

    const canvasEdit: AgentCanvasEditPlan = {
      edits: placements.map((item): AgentCanvasEdit => {
        const shift = this.byId.get(item.elementId)!
        return {
          elementId: item.elementId,
          x: item.x + shift.dx,
          y: item.y + shift.dy,
          ...(item.caption ? { name: item.caption } : {}),
          section: item.section,
        }
      }),
    }

    return { canvasEdit, text: `已把 ${placements.length} 张图排好，页签写在图的上方。${notes}` }
  }
}

/** 发话时快照优先（包括空画布）；缺席才按用户和会话读取未删除的云端项目。 */
export async function loadAgentCanvas(context: AgentToolContext): Promise<AgentCanvasView | null> {
  const live = context.canvas
  if (live) {
    const entries = live.elements.map(
      (element): CanvasEntry => ({
        id: element.id,
        type: element.type,
        description: describeLiveElement(element),
        searchable: (element.type === 'text'
          ? (element.text ?? '')
          : element.type === 'image'
            ? [element.name, element.prompt, element.section].filter(Boolean).join('\n')
            : ''
        ).toLowerCase(),
        bounds: { id: element.id, x: element.x, y: element.y, w: element.width, h: element.height },
        dx: element.type === 'image' ? (element.dx ?? 0) : 0,
        dy: element.type === 'image' ? (element.dy ?? 0) : 0,
      }),
    )
    const incomplete = live.omitted
      ? `，目录只带了前 ${entries.length} 个，还有 ${live.omitted} 个没带上`
      : ''
    return new AgentCanvasView(
      entries,
      `图片画布（用户此刻看见的，共 ${entries.length + (live.omitted ?? 0)} 个元素${incomplete}）`,
      live.omitted,
    )
  }
  const loaded = await loadDocument(context)
  if (!loaded) return null
  const { document, revision } = loaded
  const entries = document.elements.map(
    (element): CanvasEntry => ({
      id: element.id,
      type: element.type,
      description: describeElement(element),
      searchable: (element.type === 'text'
        ? element.text
        : element.type === 'image'
          ? [element.name, element.meta?.userPrompt, element.meta?.prompt]
              .filter(Boolean)
              .join('\n')
          : ''
      ).toLowerCase(),
      bounds: boundsOf(element),
      dx: 0,
      dy: 0,
    }),
  )
  const kind = document.kind === 'video' ? '视频画布' : '图片画布'
  return new AgentCanvasView(entries, `${kind}（第 ${revision} 版，共 ${entries.length} 个元素）`)
}
