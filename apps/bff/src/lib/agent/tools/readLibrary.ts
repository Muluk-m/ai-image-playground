import { agentTitleLine } from '@image-playground/shared'
import { and, desc, eq, ilike, isNull } from 'drizzle-orm'
import { Type } from 'typebox'
import { db, schema } from '../../../db/client'
import { defineAgentTool } from './adapter'
import type { AgentToolContext } from './types'

const TITLE_MAX_CHARS = 24
const RESULT_LIMIT = 20

const parameters = Type.Object({
  query: Type.Optional(
    Type.String({ description: '按名字里的关键词筛，留空就列最近用过的那些。' }),
  ),
})

/** 素材的一条视角：把服务端行读成智能体看得懂的形状。`views` 之前的行仍是一张视角。 */
export interface LibraryAssetView {
  imageId: string
  label: string
}

export interface LibraryAsset {
  name: string
  /** 封面，也是只要一张图时该用的那一张。 */
  imageId: string
  kind?: string
  views: LibraryAssetView[]
}

/**
 * 素材是按用户存的，没登录的设备在服务端没有素材库。归属条件只有这一条，
 * 不要为「设备也能查」加分支——那会把别人的素材查出来。
 */
async function search(userId: string | null, query: string | undefined): Promise<LibraryAsset[]> {
  if (!userId) return []
  const keyword = query?.trim()
  const rows = await db
    .select({
      name: schema.user_assets.name,
      imageId: schema.user_assets.image_id,
      kind: schema.user_assets.kind,
      views: schema.user_assets.views,
    })
    .from(schema.user_assets)
    .where(
      and(
        eq(schema.user_assets.user_id, userId),
        isNull(schema.user_assets.deleted_at),
        keyword ? ilike(schema.user_assets.name, `%${keyword}%`) : undefined,
      ),
    )
    .orderBy(desc(schema.user_assets.last_used_at))
    .limit(RESULT_LIMIT)
  return rows.map((row) => ({
    name: row.name ?? '',
    imageId: row.imageId ?? '',
    ...(row.kind ? { kind: row.kind } : {}),
    views:
      row.views && row.views.length > 0
        ? row.views.map((view) => ({ imageId: view.imageId, label: view.label }))
        : [{ imageId: row.imageId ?? '', label: 'none' }],
  }))
}

const KIND_LABELS: Record<string, string> = { product: '产品', person: '人物' }
const VIEW_LABELS: Record<string, string> = {
  front: '正面',
  side: '侧面',
  back: '背面',
  detail: '细节',
  sheet: '拼图',
  none: '无',
}

/** 一条素材摊成一行：名字、类别、封面图片 id，以及组里每张视角的标签与图片 id。 */
function describeAsset(asset: LibraryAsset): string {
  const kind = asset.kind ? `（${KIND_LABELS[asset.kind] ?? asset.kind}）` : ''
  const views = asset.views
    .map((view) => `${VIEW_LABELS[view.label] ?? view.label} ${view.imageId}`)
    .join('、')
  return `${asset.name}${kind}：封面图片 id ${asset.imageId}；视角 ${views}`
}

async function describe(context: AgentToolContext, query: string | undefined): Promise<string> {
  const assets = await search(context.userId, query)
  if (assets.length === 0) return '素材库里没有匹配的素材'
  return `找到 ${assets.length} 条素材：\n${assets.map(describeAsset).join('\n')}`
}

export const readLibrary = defineAgentTool({
  name: 'readLibrary',
  modes: ['image', 'video'],
  label: '查素材库',
  description:
    '按名字或关键词查用户素材库里的素材，返回名字、类别、封面图片 id 与组里每个视角的标签和图片 id。用户提到某个素材但没有在输入框里引用它时调用；查到的图片 id 可以直接交给 editImage，只要一张时用封面。',
  guidance: '用户提到某个素材但没有引用它时，先用读素材库工具按名字查到图片 id，再拿去改图。',
  parameters,
  onError: 'continue',
  // 查素材库不落画布，也没有送进上游的提示词，所以起跑时只有一行标题。
  call: ({ query }) => ({
    title:
      typeof query === 'string' && query.trim()
        ? `素材：${agentTitleLine(query, TITLE_MAX_CHARS)}`
        : '查素材库',
  }),
  execute: (context) => async (_toolCallId, params) => ({
    content: [{ type: 'text', text: await describe(context, params.query) }],
    details: {},
  }),
})
