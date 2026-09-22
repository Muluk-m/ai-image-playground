import type { ProjectDocument, ProjectElement } from '@image-playground/shared'
import { agentTitleLine, projectArtifactId } from '@image-playground/shared'
import { and, eq, isNull } from 'drizzle-orm'
import { Type } from 'typebox'
import { db, schema } from '../../../db/client'
import { defineAgentTool } from './adapter'
import type { AgentToolContext } from './types'

const TITLE_MAX_CHARS = 24
const DEFAULT_LIMIT = 30
const MAX_LIMIT = 100
/** 文字元素整段抄进结果会把一屏便签变成几千字，正文只给够认出是哪一条的长度。 */
const TEXT_PREVIEW_CHARS = 80

const parameters = Type.Object({
  query: Type.Optional(
    Type.String({ description: '按图片名或文字内容里的关键词筛，留空就看整张画布。' }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_LIMIT,
      description: `最多列几个元素，默认 ${DEFAULT_LIMIT}。`,
    }),
  ),
})

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

/** 关键词只能落在人写得出的字上：图片名与文字正文。坐标、颜色、id 都不该被关键词命中。 */
function matches(element: ProjectElement, keyword: string): boolean {
  if (element.type === 'text') return element.text.toLowerCase().includes(keyword)
  if (element.type === 'image') return (element.name ?? '').toLowerCase().includes(keyword)
  return false
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
      return `${head}：${kind}${name}，图片 id ${element.mediaId}，${box(element)}`
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

async function describe(
  context: AgentToolContext,
  params: { query?: string; limit?: number },
): Promise<string> {
  const loaded = await loadDocument(context)
  if (!loaded) return '这一轮没有服务端画布可读（画布只在本地，或者用户没登录）。'
  const { document, revision } = loaded
  const keyword = params.query?.trim().toLowerCase()
  const all = document.elements
  const picked = keyword ? all.filter((element) => matches(element, keyword)) : all
  const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
  const shown = picked.slice(0, limit)
  const kind = document.kind === 'video' ? '视频画布' : '图片画布'
  const head = keyword
    ? `${kind}（第 ${revision} 版，共 ${all.length} 个元素），关键词命中 ${picked.length} 个`
    : `${kind}（第 ${revision} 版，共 ${all.length} 个元素）`
  if (shown.length === 0) return `${head}：没有可列的元素。`
  const more =
    picked.length > shown.length ? `\n（还有 ${picked.length - shown.length} 个没列出来）` : ''
  return `${head}：\n${shown.map(describeElement).join('\n')}${more}`
}

export const readCanvas = defineAgentTool({
  name: 'readCanvas',
  modes: ['image', 'video'],
  label: '看画布',
  description:
    '看当前这张画布上有什么：每个元素的类型、位置、尺寸，图片给得出图片 id。用户提到画布上某个东西却没有在输入框里引用它时调用（「左边那张」「刚才那张图」「这些图」）。注意元素 id 与图片 id 不是一回事，只有图片 id 能交给 viewImage 或 editImage。',
  guidance:
    '用户指着画布上的东西说话（「左边那张」「这几张」「刚才那张」）却没有引用图片时，先看画布拿到图片 id，再去看图或改图。',
  parameters,
  onError: 'continue',
  // 读画布不落画布，也没有送进上游的提示词，所以起跑时只有一行标题。
  call: ({ query }) => ({
    title:
      typeof query === 'string' && query.trim()
        ? `看画布：${agentTitleLine(query, TITLE_MAX_CHARS)}`
        : '看画布',
  }),
  execute: (context) => async (_toolCallId, params) => ({
    content: [{ type: 'text', text: await describe(context, params) }],
    details: {},
  }),
})
