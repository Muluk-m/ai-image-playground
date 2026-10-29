import { createHash } from 'node:crypto'
import {
  type AgentContentBlock,
  type CloudProjectSummary,
  PROJECT_RECEIPT_COUNT,
  PROJECT_SUMMARY_MAX_LENGTH,
  type ProjectPage,
  type ProjectWrite,
} from '@image-playground/shared'
import { and, asc, count, desc, eq, gt, gte, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import { config } from '../config'
import { db, schema } from '../db/client'
import { withAgentLifecycle } from './agent/lifecycle'
import { runningTurn } from './agent/runningTurns'
import type { BffTransaction } from './private-overlay'

const table = schema.canvas_projects

/** 对话项目的封面候选：同一会话最近一次生成的第一个已就绪输出，图片排在视频前面。 */
function conversationCover(column: 'id' | 'content_type') {
  return sql`
    SELECT ${sql.raw(`m.${column}`)}
    FROM ${schema.generation_records} g
    JOIN ${schema.generation_images} gi ON gi.generation_id = g.id AND gi.role = 'output'
    JOIN ${schema.media_objects} m ON m.id = gi.media_id AND m.user_id = g.user_id
    WHERE "canvas_projects"."conversation_id" IS NOT NULL
      AND g.user_id = "canvas_projects"."user_id"
      AND g.deleted_at IS NULL
      AND g.source ->> 'conversationId' = "canvas_projects"."conversation_id"
      AND m.status = 'ready'
      AND (m.content_type LIKE 'image/%' OR m.content_type LIKE 'video/%')
    ORDER BY (m.content_type LIKE 'image/%') DESC, g.created_at DESC, gi.position ASC
    LIMIT 1`
}
const summaryColumns = {
  id: table.id,
  name: table.name,
  revision: table.revision,
  createdAt: table.created_at,
  updatedAt: table.updated_at,
  elementCount: table.element_count,
  // 封面取画布上最后一张图（视频元素存的也是它的封面帧）；对话项目的结果留在对话里、画布常是空的，
  // 就退到这个会话最近一次生成的第一个输出。图片优先；只出过视频的对话拿视频本身，由客户端取首帧。
  coverMediaId: sql<string | null>`COALESCE(${table.cover_media_id}, (${conversationCover('id')}))`,
  coverIsVideo: sql<boolean>`CASE WHEN ${table.cover_media_id} IS NULL
    THEN COALESCE((${conversationCover('content_type')}) LIKE 'video/%', false) ELSE false END`,
  conversationId: table.conversation_id,
  experience: sql<'chat' | 'canvas' | null>`${table.document}->>'experience'`,
  sourceProjectId: sql<string | null>`${table.document}->>'sourceProjectId'`,
}

export async function listProjects(userId: string, pageSize: number, cursor?: string) {
  const rows = await db
    .select(summaryColumns)
    .from(table)
    .where(
      and(
        eq(table.user_id, userId),
        isNull(table.deleted_at),
        cursor ? gt(table.id, cursor) : undefined,
      ),
    )
    .orderBy(asc(table.id))
    .limit(pageSize + 1)
  const deleted = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.user_id, userId), isNotNull(table.deleted_at)))
  return {
    projects: rows
      .slice(0, pageSize)
      .filter((row) => !deleted.some((one) => one.id === row.id))
      .map(summaryView),
    deletedIds: deleted.map((one) => one.id),
    nextCursor: rows.length > pageSize ? rows[pageSize - 1]!.id : null,
  }
}

const DELETED_REPLAY_MS = 60_000

export type RecentProjectCursor = { updatedAt: number; id: string }

export function encodeRecentProjectCursor(cursor: RecentProjectCursor): string {
  return Buffer.from(JSON.stringify([cursor.updatedAt, cursor.id])).toString('base64url')
}

export function decodeRecentProjectCursor(value: string): RecentProjectCursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (!Array.isArray(parsed) || parsed.length !== 2) return null
    const [updatedAt, id] = parsed
    if (!Number.isSafeInteger(updatedAt) || typeof id !== 'string') return null
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null
    return { updatedAt, id }
  } catch {
    return null
  }
}

/**
 * 游标只带到毫秒（`epochMs` 读出来就是毫秒），比较和排序也截到毫秒；
 * 否则库里带微秒的行会和游标对不齐，同一毫秒的并列行被跳过。参数按 timestamptz 传，不能拿数字直接比。
 */
const updatedAtMs = sql`date_trunc('milliseconds', ${table.updated_at})`

/**
 * 最近更新的排前面：`updated_at desc, id desc` 复合游标。第一页顺带给总数和增量删除。
 *
 * 不加索引：项目数受每人上限约束（`sync:projects`），按 owner 索引取出这个用户的全部行再排序，
 * 量级是几十到一百来行。删除只回 `deletedSince` 之后删的，客户端记住 `deletedThrough` 下次接着问。
 */
export async function listRecentProjects(
  userId: string,
  pageSize: number,
  cursor?: RecentProjectCursor,
  deletedSince?: number,
): Promise<ProjectPage> {
  // 往回留一段余量：删除事务先取时间再提交，比这次读晚提交的删除下次仍要回给客户端。重复下发无害。
  const deletedThrough = Date.now() - DELETED_REPLAY_MS
  const rows = await db
    .select(summaryColumns)
    .from(table)
    .where(
      and(
        eq(table.user_id, userId),
        isNull(table.deleted_at),
        cursor
          ? sql`(${updatedAtMs}, ${table.id}) < (${new Date(cursor.updatedAt).toISOString()}::timestamptz, ${cursor.id})`
          : undefined,
      ),
    )
    .orderBy(desc(updatedAtMs), desc(table.id))
    .limit(pageSize + 1)
  const selected = rows.slice(0, pageSize)
  const summaries = await withConversationSummaries(userId, selected.map(summaryView))
  const last = selected.at(-1)
  const nextCursor =
    rows.length > pageSize && last
      ? encodeRecentProjectCursor({ updatedAt: last.updatedAt, id: last.id })
      : null
  if (cursor) return { projects: summaries, nextCursor }
  const [deleted, [totals]] = await Promise.all([
    db
      .select({ id: table.id })
      .from(table)
      .where(
        and(
          eq(table.user_id, userId),
          isNotNull(table.deleted_at),
          deletedSince === undefined ? undefined : gte(table.deleted_at, deletedSince),
        ),
      ),
    db
      .select({
        all: sql<number>`count(*)::int`,
        // 与客户端 projectExperience 同一口径：没写入口类型的，挂着会话或画布为空都算对话。
        chat: sql<number>`(count(*) filter (where ${table.document} ->> 'experience' = 'chat' or (
          ${table.document} ->> 'experience' is null
          and (${table.conversation_id} is not null or ${table.element_count} = 0)
        )))::int`,
      })
      .from(table)
      .where(and(eq(table.user_id, userId), isNull(table.deleted_at))),
  ])
  return {
    projects: summaries,
    nextCursor,
    deletedIds: deleted.map((one) => one.id),
    deletedThrough,
    totals: { all: totals?.all ?? 0, chat: totals?.chat ?? 0 },
  }
}

/** 只在封面是视频时带上标记，旧客户端看到的摘要不变。 */
function summaryView<T extends { coverIsVideo: boolean }>({
  coverIsVideo,
  ...row
}: T): Omit<T, 'coverIsVideo'> & { coverIsVideo?: true } {
  return coverIsVideo ? { ...row, coverIsVideo: true } : row
}

export function messageSummary(content: readonly AgentContentBlock[]): string {
  const text = content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > PROJECT_SUMMARY_MAX_LENGTH
    ? `${text.slice(0, PROJECT_SUMMARY_MAX_LENGTH - 1)}…`
    : text
}

/**
 * 没封面的对话卡显示首条用户消息的摘要，不再是一排图标。只查这一页里没封面的会话，
 * 走 `idx_agent_messages_conversation_seq`，每个会话取 seq 最小的那条。
 */
async function withConversationSummaries(
  userId: string,
  projects: CloudProjectSummary[],
): Promise<CloudProjectSummary[]> {
  const conversations = projects.flatMap((project) =>
    !project.coverMediaId && project.conversationId ? [project.conversationId] : [],
  )
  if (!conversations.length) return projects
  const messages = await db
    .selectDistinctOn([schema.agent_messages.conversation_id], {
      conversationId: schema.agent_messages.conversation_id,
      content: schema.agent_messages.content,
    })
    .from(schema.agent_messages)
    .innerJoin(
      schema.agent_conversations,
      eq(schema.agent_conversations.id, schema.agent_messages.conversation_id),
    )
    .where(
      and(
        inArray(schema.agent_messages.conversation_id, conversations),
        eq(schema.agent_conversations.user_id, userId),
        eq(schema.agent_messages.role, 'user'),
        isNull(schema.agent_messages.deleted_at),
      ),
    )
    .orderBy(asc(schema.agent_messages.conversation_id), asc(schema.agent_messages.seq))
  const summaries = new Map(
    messages.map((message) => [message.conversationId, messageSummary(message.content)]),
  )
  return projects.map((project) => {
    const summary = project.conversationId ? summaries.get(project.conversationId) : undefined
    return summary && !project.coverMediaId ? { ...project, summary } : project
  })
}

export async function readProject(userId: string, id: string) {
  const [project] = await db
    .select({ ...summaryColumns, document: table.document, deletedAt: table.deleted_at })
    .from(table)
    .where(and(eq(table.user_id, userId), eq(table.id, id)))
  return project ? summaryView(project) : null
}

export async function writeProject(userId: string, id: string, input: ProjectWrite) {
  const digest = createHash('sha256')
    .update(JSON.stringify([input.baseRevision, input.name, input.document]))
    .digest('hex')
  return db.transaction(async (tx) => {
    // 所有项目写入在所有者行上串行，首次创建与已有项目写入共用一个事务边界。
    await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .for('update')
    const [existing] = await tx
      .select()
      .from(table)
      .where(and(eq(table.id, id), eq(table.user_id, userId)))
    if (existing?.deleted_at != null)
      return { ok: false as const, status: 410 as const, error: 'project_deleted' }
    const [migrated] = existing
      ? await tx
          .select({ id: schema.canvas_documents.project_id })
          .from(schema.canvas_documents)
          .where(eq(schema.canvas_documents.project_id, id))
      : []
    if (migrated)
      return { ok: false as const, status: 409 as const, error: 'project_canvas_upgrade_required' }
    const receipt = existing?.receipts.find((one) => one.requestId === input.requestId)
    if (receipt)
      return receipt.digest === digest
        ? { ok: true as const, project: receipt.result }
        : { ok: false as const, status: 409 as const, error: 'request_id_reused' }
    if ((existing?.revision ?? 0) !== input.baseRevision)
      return {
        ok: false as const,
        status: 409 as const,
        error: 'project_conflict',
        revision: existing?.revision ?? 0,
      }
    const reservations = input.document.elements.filter((element) => element.type === 'generation')
    if (reservations.length) {
      const owned = await tx
        .select()
        .from(schema.project_generation_outputs)
        .where(
          and(
            eq(schema.project_generation_outputs.user_id, userId),
            eq(schema.project_generation_outputs.project_id, id),
            inArray(
              schema.project_generation_outputs.object_id,
              reservations.map((element) => element.id),
            ),
          ),
        )
      if (
        reservations.some(
          (element) =>
            !existing?.document.elements.some(
              (current) =>
                current.type === 'generation' &&
                current.id === element.id &&
                current.generationId === element.generationId &&
                current.position === element.position &&
                // 失败与否只由服务端在任务终态时写，客户端只能原样带回或删掉。
                current.errorCode === element.errorCode,
            ) ||
            !owned.some(
              (output) =>
                output.object_id === element.id &&
                output.generation_id === element.generationId &&
                output.position === element.position,
            ),
        )
      )
        return { ok: false as const, status: 409 as const, error: 'project_output_not_owned' }
    }
    const imageIds = input.document.elements.flatMap((element) =>
      element.type === 'image' ? [element.mediaId] : [],
    )
    const videoIds = input.document.elements.flatMap((el) =>
      el.type === 'image' && el.video?.mediaId ? [el.video.mediaId] : [],
    )
    const mediaIds = [...new Set([...imageIds, ...videoIds])]
    if (mediaIds.length) {
      const ready = await tx
        .select({ id: schema.media_objects.id, contentType: schema.media_objects.content_type })
        .from(schema.media_objects)
        .where(
          and(
            eq(schema.media_objects.user_id, userId),
            eq(schema.media_objects.status, 'ready'),
            inArray(schema.media_objects.id, mediaIds),
          ),
        )
      if (
        ready.length !== mediaIds.length ||
        ready.some((media) => videoIds.includes(media.id) && media.contentType !== 'video/mp4')
      )
        return { ok: false as const, status: 409 as const, error: 'project_media_not_ready' }
    }
    const now = Date.now()
    // 入口类型和来源跟随项目文档同步；已有类型只认第一次写入，避免旧客户端覆盖。
    const document = existing
      ? {
          ...input.document,
          kind: existing.document.kind,
          experience: existing.document.experience ?? input.document.experience,
          sourceProjectId: existing.document.sourceProjectId ?? input.document.sourceProjectId,
        }
      : input.document
    const project: CloudProjectSummary = {
      id,
      name: input.name,
      revision: (existing?.revision ?? 0) + 1,
      createdAt: existing?.created_at ?? now,
      updatedAt: now,
      elementCount: input.document.elements.length,
      coverMediaId: imageIds.at(-1) ?? null,
      conversationId: existing?.conversation_id ?? null,
      ...(document.experience ? { experience: document.experience } : {}),
      ...(document.sourceProjectId ? { sourceProjectId: document.sourceProjectId } : {}),
    }
    const values = {
      name: project.name,
      revision: project.revision,
      document,
      element_count: project.elementCount,
      cover_media_id: project.coverMediaId,
      updated_at: now,
      receipts: [
        ...(existing?.receipts ?? []),
        { requestId: input.requestId, digest, result: project },
      ].slice(-PROJECT_RECEIPT_COUNT),
    }
    if (existing) {
      await tx
        .update(table)
        .set(values)
        .where(and(eq(table.id, id), eq(table.user_id, userId)))
    } else {
      if (await projectQuotaFull(tx, userId))
        return { ok: false as const, status: 413 as const, error: 'project_quota_exceeded' }
      const created = await tx
        .insert(table)
        .values({ id, user_id: userId, created_at: now, ...values })
        .onConflictDoNothing()
        .returning({ id: table.id })
      if (!created.length)
        return { ok: false as const, status: 404 as const, error: 'project_not_found' }
    }
    await tx
      .delete(schema.media_references)
      .where(
        and(
          eq(schema.media_references.user_id, userId),
          eq(schema.media_references.owner_kind, 'project'),
          eq(schema.media_references.owner_id, id),
        ),
      )
    if (mediaIds.length)
      await tx.insert(schema.media_references).values(
        mediaIds.map((mediaId) => ({
          user_id: userId,
          media_id: mediaId,
          owner_kind: 'project' as const,
          owner_id: id,
          created_at: now,
        })),
      )
    return { ok: true as const, project }
  })
}

export async function listRecycledProjects(userId: string, pageSize: number, cursor?: string) {
  const rows = await db
    .select({ ...summaryColumns, deletedAt: table.deleted_at, restoreUntil: table.restore_until })
    .from(table)
    .where(
      and(
        eq(table.user_id, userId),
        gt(table.restore_until, Date.now()),
        cursor ? gt(table.id, cursor) : undefined,
      ),
    )
    .orderBy(asc(table.id))
    .limit(pageSize + 1)
  return {
    projects: rows.slice(0, pageSize).map(summaryView),
    nextCursor: rows.length > pageSize ? rows[pageSize - 1]!.id : null,
  }
}

/** 项目数额度只算没删的项目；回收站里的不占位置，恢复时再按额度检查（BUG-52）。 */
export async function projectQuotaFull(tx: BffTransaction, userId: string): Promise<boolean> {
  const [total] = await tx
    .select({ count: count() })
    .from(table)
    .where(and(eq(table.user_id, userId), isNull(table.deleted_at)))
  return (total?.count ?? 0) >= config.operator.quotas['sync:user-projects']
}

export async function recycleProject(userId: string, id: string, restore = false) {
  return withAgentLifecycle({ kind: 'user', userId }, () =>
    db.transaction(async (tx) => {
      await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .for('update')
      const [project] = await tx
        .select()
        .from(table)
        .where(and(eq(table.user_id, userId), eq(table.id, id)))
      if (!project) return { ok: false as const, status: 404 as const, error: 'project_not_found' }
      const now = Date.now()
      if (restore && project.deleted_at != null && (project.restore_until ?? 0) <= now)
        return { ok: false as const, status: 410 as const, error: 'project_expired' }
      if ((project.deleted_at == null) === restore) return { ok: true as const }
      if (restore && (await projectQuotaFull(tx, userId)))
        return { ok: false as const, status: 413 as const, error: 'project_quota_exceeded' }
      if (!restore && project.conversation_id) {
        const [task] = await tx
          .select({ id: schema.tasks.id })
          .from(schema.tasks)
          .where(
            and(
              eq(schema.tasks.user_id, userId),
              eq(schema.tasks.agent_conversation_id, project.conversation_id),
              inArray(schema.tasks.status, ['queued', 'in_progress']),
            ),
          )
          .limit(1)
        if (runningTurn(project.conversation_id) || task)
          return { ok: false as const, status: 409 as const, error: 'project_busy' }
      }
      const deletedAt = restore ? null : now
      await tx
        .update(table)
        .set({
          deleted_at: deletedAt,
          restore_until: restore
            ? null
            : now + config.operator.quotas['sync:project-recycle-days'] * 86400000,
          revision: project.revision + 1,
          receipts: [],
          updated_at: now,
        })
        .where(and(eq(table.user_id, userId), eq(table.id, id)))
      if (project.conversation_id)
        await tx
          .update(schema.agent_conversations)
          .set({ deleted_at: deletedAt, updated_at: now })
          .where(
            and(
              eq(schema.agent_conversations.id, project.conversation_id),
              eq(schema.agent_conversations.user_id, userId),
            ),
          )
      return { ok: true as const }
    }),
  )
}
