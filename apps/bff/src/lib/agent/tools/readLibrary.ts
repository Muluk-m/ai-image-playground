import type { AgentTool } from '@earendil-works/pi-agent-core'
import { agentTitleLine } from '@image-playground/shared'
import { and, desc, eq, ilike, isNull } from 'drizzle-orm'
import { Type } from 'typebox'
import { db, schema } from '../../../db/client'
import type { AgentToolContext, AgentToolDefinition, AgentToolDetails } from './types'

const TITLE_MAX_CHARS = 24
const RESULT_LIMIT = 20

const parameters = Type.Object({
  query: Type.Optional(
    Type.String({ description: '按名字里的关键词筛，留空就列最近用过的那些。' }),
  ),
})

function title(args: unknown): string {
  const query = (args as { query?: unknown } | null)?.query
  return typeof query === 'string' && query.trim()
    ? `素材：${agentTitleLine(query, TITLE_MAX_CHARS)}`
    : '查素材库'
}

/**
 * 素材是按用户存的，没登录的设备在服务端没有素材库。归属条件只有这一条，
 * 不要为「设备也能查」加分支——那会把别人的素材查出来。
 */
async function search(userId: string | null, query: string | undefined) {
  if (!userId) return []
  const keyword = query?.trim()
  return db
    .select({ name: schema.user_assets.name, imageId: schema.user_assets.image_id })
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
}

async function describe(context: AgentToolContext, query: string | undefined): Promise<string> {
  const rows = await search(context.userId, query)
  if (rows.length === 0) return '素材库里没有匹配的素材'
  const lines = rows.map((row) => `${row.name}：图片 id ${row.imageId}`)
  return `找到 ${rows.length} 条素材：\n${lines.join('\n')}`
}

export const readLibrary: AgentToolDefinition = {
  name: 'readLibrary',
  guidance: '用户提到某个素材但没有引用它时，先用读素材库工具按名字查到图片 id，再拿去改图。',
  title,
  onError: 'continue',
  create(context) {
    const tool: AgentTool<typeof parameters, AgentToolDetails> = {
      name: 'readLibrary',
      label: '查素材库',
      description:
        '按名字或关键词查用户素材库里的素材，返回名字与图片 id。用户提到某个素材但没有在输入框里引用它时调用；查到的图片 id 可以直接交给 editImage。',
      parameters,
      async execute(_toolCallId, params) {
        return {
          content: [{ type: 'text', text: await describe(context, params.query) }],
          details: {},
        }
      },
    }
    return tool as AgentTool
  },
}
