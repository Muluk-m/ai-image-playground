import { randomUUID } from 'node:crypto'
import type {
  AnnouncementAdminItem,
  AnnouncementAudience,
  AnnouncementDraft,
  AnnouncementListResult,
  AnnouncementLocale,
  AnnouncementPublicItem,
  AnnouncementPublicList,
  AnnouncementType,
} from '@image-playground/shared'
import {
  announcementIsVisible,
  announcementMatchesAudience,
  announcementPublication,
  effectiveAnnouncementStatus,
  localizeAnnouncement,
  parseAnnouncementDraft,
} from '@image-playground/shared'
import { and, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import { config } from '../config'
import { db, schema } from '../db/client'

export type AnnouncementOperationErrorCode =
  | 'not_found'
  | 'invalid_announcement'
  | 'invalid_reason'
  | 'invalid_window'

export class AnnouncementOperationError extends Error {
  constructor(readonly code: AnnouncementOperationErrorCode) {
    super(code)
    this.name = 'AnnouncementOperationError'
  }
}

const publicAssetUrl = (key: string | null): string | null => {
  if (!key) return null
  if (/^https?:\/\//.test(key)) return key
  const base = config.publicAssets.baseUrl
  if (!base) return null
  return `${base}/${key.replace(/^\/+/, '')}`
}

type AnnouncementRow = typeof schema.announcements.$inferSelect

function draftFromRow(row: AnnouncementRow): AnnouncementDraft {
  return {
    type: row.type,
    importance: row.importance,
    titleZh: row.title_zh,
    bodyZh: row.body_zh,
    titleEn: row.title_en,
    bodyEn: row.body_en,
    coverKey: row.cover_key,
    ctaLabel: row.cta_label,
    ctaUrl: row.cta_url,
    versionTag: row.version_tag,
    audience: row.audience,
    publishAt: row.publish_at,
    expireAt: row.expire_at,
  }
}

function requireReason(reason: string): string {
  const trimmed = reason.trim()
  if (!trimmed || trimmed.length > 500) throw new AnnouncementOperationError('invalid_reason')
  return trimmed
}

function requireDraft(input: unknown): AnnouncementDraft {
  const draft = parseAnnouncementDraft(input)
  if (!draft) throw new AnnouncementOperationError('invalid_announcement')
  return draft
}

const audit = (
  action: string,
  targetId: string,
  operatorId: string,
  details: Record<string, unknown>,
) => ({
  id: randomUUID(),
  operator_id: operatorId,
  action,
  target_type: 'announcement',
  target_id: targetId,
  details,
  created_at: Date.now(),
})

async function audienceSize(audience: AnnouncementAudience): Promise<number | null> {
  if (audience === 'anonymous') return null
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.users)
    .where(eq(schema.users.status, 'active'))
  return Number(row?.count ?? 0)
}

async function readCounts(): Promise<Map<string, number>> {
  const rows = await db
    .select({
      id: schema.announcement_reads.announcement_id,
      reads: sql<number>`count(*) filter (where ${schema.announcement_reads.read_at} is not null)::int`,
    })
    .from(schema.announcement_reads)
    .groupBy(schema.announcement_reads.announcement_id)
  return new Map(rows.map((row) => [row.id, Number(row.reads)]))
}

function toAdmin(
  row: AnnouncementRow,
  reads: Map<string, number>,
  now: number,
  signedInReach: number,
): AnnouncementAdminItem {
  const readCount = reads.get(row.id) ?? 0
  const size = row.audience === 'anonymous' ? null : signedInReach
  const effectiveStatus = effectiveAnnouncementStatus(
    { status: row.status, publishAt: row.publish_at, expireAt: row.expire_at },
    now,
  )
  const readRate =
    size && effectiveStatus !== 'draft' && effectiveStatus !== 'scheduled'
      ? Math.round((readCount / size) * 1000) / 10
      : null
  return {
    ...draftFromRow(row),
    id: row.id,
    status: row.status,
    effectiveStatus,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    readCount,
    audienceSize: size,
    readRate,
    coverUrl: publicAssetUrl(row.cover_key),
  }
}

export interface AnnouncementListFilter {
  status?: string
  type?: string
  q?: string
  language?: string
  withinDays?: number
}

function matchesFilter(
  item: AnnouncementAdminItem,
  filter: AnnouncementListFilter,
  now: number,
): boolean {
  if (filter.status && filter.status !== 'all' && item.effectiveStatus !== filter.status)
    return false
  if (filter.type && filter.type !== 'all' && item.type !== filter.type) return false
  if (filter.language === 'en' && !(item.titleEn && item.bodyEn)) return false
  if (filter.language === 'zh' && (item.titleEn || item.bodyEn)) return false
  if (filter.withinDays && filter.withinDays > 0) {
    const stamp = item.publishAt ?? item.updatedAt
    if (stamp < now - filter.withinDays * 86_400_000) return false
  }
  if (filter.q?.trim()) {
    const needle = filter.q.trim().toLowerCase()
    const haystack = [item.titleZh, item.titleEn, item.versionTag, item.id]
      .filter(Boolean)
      .join('\n')
      .toLowerCase()
    if (!haystack.includes(needle)) return false
  }
  return true
}

export async function listAnnouncements(
  filter: AnnouncementListFilter = {},
  webOrigin: string | null = null,
): Promise<AnnouncementListResult> {
  const now = Date.now()
  const rows = await db
    .select()
    .from(schema.announcements)
    .orderBy(desc(schema.announcements.publish_at), desc(schema.announcements.updated_at))
  const reads = await readCounts()
  const signedInReach = await audienceSize('all')
  const items = rows.map((row) => toAdmin(row, reads, now, signedInReach ?? 0))
  const counts: AnnouncementListResult['counts'] = {
    all: items.length,
    draft: 0,
    scheduled: 0,
    published: 0,
    archived: 0,
  }
  for (const item of items) counts[item.effectiveStatus] += 1
  const matched = items.filter((item) => matchesFilter(item, filter, now))
  const nextScheduleAt =
    items
      .filter((item) => item.effectiveStatus === 'scheduled' && item.publishAt != null)
      .map((item) => item.publishAt as number)
      .sort((left, right) => left - right)[0] ?? null
  return { items: matched, counts, matched: matched.length, nextScheduleAt, webOrigin }
}

async function loadRow(id: string): Promise<AnnouncementRow> {
  const [row] = await db
    .select()
    .from(schema.announcements)
    .where(eq(schema.announcements.id, id))
    .limit(1)
  if (!row) throw new AnnouncementOperationError('not_found')
  return row
}

export async function getAnnouncement(id: string): Promise<AnnouncementAdminItem> {
  const reads = await readCounts()
  const signedInReach = (await audienceSize('all')) ?? 0
  return toAdmin(await loadRow(id), reads, Date.now(), signedInReach)
}

function columns(draft: AnnouncementDraft, now: number, operatorId: string) {
  return {
    type: draft.type,
    importance: draft.importance,
    title_zh: draft.titleZh,
    body_zh: draft.bodyZh,
    title_en: draft.titleEn,
    body_en: draft.bodyEn,
    cover_key: draft.coverKey,
    cta_label: draft.ctaLabel,
    cta_url: draft.ctaUrl,
    version_tag: draft.versionTag,
    audience: draft.audience,
    publish_at: draft.publishAt,
    expire_at: draft.expireAt,
    updated_by: operatorId,
    updated_at: now,
  }
}

export async function createAnnouncement(
  input: unknown,
  operatorId: string,
): Promise<AnnouncementAdminItem> {
  const draft = requireDraft(input)
  const now = Date.now()
  const id = `ann_${randomUUID()}`
  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(schema.announcements)
      .values({
        id,
        ...columns(draft, now, operatorId),
        status: 'draft',
        created_by: operatorId,
        created_at: now,
      })
      .returning()
    if (!created) throw new Error('created announcement missing')
    await tx
      .insert(schema.operator_audits)
      .values(audit('announcement.create', id, operatorId, { type: created.type, imported: false }))
    return toAdmin(created, new Map(), now, (await audienceSize('all')) ?? 0)
  })
}

export async function importAnnouncement(
  input: unknown,
  operatorId: string,
): Promise<AnnouncementAdminItem> {
  const record =
    input !== null && typeof input === 'object' && 'announcement' in input
      ? (input as { announcement: unknown }).announcement
      : input
  const draft = requireDraft(record)
  const now = Date.now()
  const id = `ann_${randomUUID()}`
  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(schema.announcements)
      .values({
        id,
        ...columns(draft, now, operatorId),
        status: 'draft',
        created_by: operatorId,
        created_at: now,
      })
      .returning()
    if (!created) throw new Error('created announcement missing')
    await tx
      .insert(schema.operator_audits)
      .values(audit('announcement.create', id, operatorId, { type: created.type, imported: true }))
    return toAdmin(created, new Map(), now, (await audienceSize('all')) ?? 0)
  })
}

export async function updateAnnouncement(
  id: string,
  input: unknown,
  operatorId: string,
): Promise<AnnouncementAdminItem> {
  const draft = requireDraft(input)
  const existing = await loadRow(id)
  if (!announcementPublication.allows(existing.status, 'revise')) {
    throw new AnnouncementOperationError('invalid_announcement')
  }
  const now = Date.now()
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(schema.announcements)
      .set(columns(draft, now, operatorId))
      .where(eq(schema.announcements.id, id))
      .returning()
    if (!updated) throw new AnnouncementOperationError('not_found')
    await tx
      .insert(schema.operator_audits)
      .values(audit('announcement.update', id, operatorId, { status: updated.status }))
    return toAdmin(updated, await readCounts(), now, (await audienceSize('all')) ?? 0)
  })
}

function publishFields(draft: AnnouncementDraft, requestedAt: number | null, now: number) {
  const publishAt = requestedAt ?? draft.publishAt ?? now
  if (draft.expireAt != null && draft.expireAt <= publishAt) {
    throw new AnnouncementOperationError('invalid_window')
  }
  if (!draft.titleZh.trim() || !draft.bodyZh.trim()) {
    throw new AnnouncementOperationError('invalid_announcement')
  }
  const status = announcementPublication.target(publishAt > now ? 'schedule' : 'publish')
  return { status, publish_at: publishAt }
}

export async function publishAnnouncement(
  id: string,
  reason: string,
  publishAt: number | null,
  operatorId: string,
): Promise<AnnouncementAdminItem> {
  const why = requireReason(reason)
  const existing = await loadRow(id)
  if (
    !announcementPublication.allows(existing.status, 'publish') &&
    !announcementPublication.allows(existing.status, 'schedule')
  ) {
    throw new AnnouncementOperationError('invalid_announcement')
  }
  const next = publishFields(draftFromRow(existing), publishAt, Date.now())
  const now = Date.now()
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(schema.announcements)
      .set({ ...next, updated_at: now, updated_by: operatorId })
      .where(eq(schema.announcements.id, id))
      .returning()
    if (!updated) throw new AnnouncementOperationError('not_found')
    await tx.insert(schema.operator_audits).values(
      audit('announcement.publish', id, operatorId, {
        reason: why,
        status: updated.status,
        publishAt: updated.publish_at,
      }),
    )
    return toAdmin(updated, await readCounts(), now, (await audienceSize('all')) ?? 0)
  })
}

export async function unpublishAnnouncement(
  id: string,
  reason: string,
  operatorId: string,
): Promise<AnnouncementAdminItem> {
  const why = requireReason(reason)
  const existing = await loadRow(id)
  if (!announcementPublication.allows(existing.status, 'unpublish')) {
    throw new AnnouncementOperationError('invalid_announcement')
  }
  const now = Date.now()
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(schema.announcements)
      .set({
        status: announcementPublication.target('unpublish'),
        updated_at: now,
        updated_by: operatorId,
      })
      .where(eq(schema.announcements.id, id))
      .returning()
    if (!updated) throw new AnnouncementOperationError('not_found')
    await tx
      .insert(schema.operator_audits)
      .values(audit('announcement.unpublish', id, operatorId, { reason: why }))
    return toAdmin(updated, await readCounts(), now, (await audienceSize('all')) ?? 0)
  })
}

export async function archiveAnnouncement(
  id: string,
  reason: string,
  operatorId: string,
): Promise<AnnouncementAdminItem> {
  const why = requireReason(reason)
  await loadRow(id)
  const now = Date.now()
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(schema.announcements)
      .set({
        status: announcementPublication.target('archive'),
        updated_at: now,
        updated_by: operatorId,
      })
      .where(eq(schema.announcements.id, id))
      .returning()
    if (!updated) throw new AnnouncementOperationError('not_found')
    await tx
      .insert(schema.operator_audits)
      .values(audit('announcement.archive', id, operatorId, { reason: why }))
    return toAdmin(updated, await readCounts(), now, (await audienceSize('all')) ?? 0)
  })
}

function toPublic(
  row: AnnouncementRow,
  locale: AnnouncementLocale,
  read: { read_at: number | null; dismissed_at: number | null } | undefined,
): AnnouncementPublicItem {
  const copy = localizeAnnouncement(
    {
      titleZh: row.title_zh,
      bodyZh: row.body_zh,
      titleEn: row.title_en,
      bodyEn: row.body_en,
    },
    locale,
  )
  return {
    id: row.id,
    type: row.type,
    importance: row.importance,
    title: copy.title,
    body: copy.body,
    usedFallback: copy.usedFallback,
    coverUrl: publicAssetUrl(row.cover_key),
    ctaLabel: row.cta_label,
    ctaUrl: row.cta_url,
    versionTag: row.version_tag,
    publishAt: row.publish_at,
    unread: read?.read_at == null,
    dismissed: read?.dismissed_at != null,
  }
}

export async function listPublicAnnouncements(
  locale: AnnouncementLocale,
  userId: string | null,
): Promise<AnnouncementPublicList> {
  const now = Date.now()
  const rows = await db
    .select()
    .from(schema.announcements)
    .where(
      and(
        inArray(schema.announcements.status, ['published', 'scheduled']),
        or(isNull(schema.announcements.publish_at), lte(schema.announcements.publish_at, now)),
        or(isNull(schema.announcements.expire_at), gt(schema.announcements.expire_at, now)),
      ),
    )
    .orderBy(desc(schema.announcements.publish_at), desc(schema.announcements.id))
  const viewer = userId ? 'logged_in' : 'anonymous'
  const visible = rows.filter(
    (row) =>
      announcementIsVisible(
        { status: row.status, publishAt: row.publish_at, expireAt: row.expire_at },
        now,
      ) && announcementMatchesAudience(row.audience, viewer),
  )
  const reads = new Map<string, { read_at: number | null; dismissed_at: number | null }>()
  if (userId && visible.length) {
    const stored = await db
      .select()
      .from(schema.announcement_reads)
      .where(
        and(
          eq(schema.announcement_reads.user_id, userId),
          inArray(
            schema.announcement_reads.announcement_id,
            visible.map((row) => row.id),
          ),
        ),
      )
    for (const read of stored) reads.set(read.announcement_id, read)
  }
  const items = visible.map((row) => toPublic(row, locale, reads.get(row.id)))
  return { items, unreadCount: items.filter((item) => item.unread).length }
}

async function markRead(userId: string, ids: string[], dismissed: boolean): Promise<void> {
  if (!ids.length) return
  const now = Date.now()
  const existing = await db
    .select({ id: schema.announcements.id })
    .from(schema.announcements)
    .where(inArray(schema.announcements.id, ids))
  const found = existing.map((row) => row.id)
  if (!found.length) return
  await db
    .insert(schema.announcement_reads)
    .values(
      found.map((id) => ({
        user_id: userId,
        announcement_id: id,
        read_at: now,
        dismissed_at: dismissed ? now : null,
      })),
    )
    .onConflictDoUpdate({
      target: [schema.announcement_reads.user_id, schema.announcement_reads.announcement_id],
      set: {
        read_at: sql`coalesce(${schema.announcement_reads.read_at}, ${new Date(now).toISOString()}::timestamptz)`,
        dismissed_at: dismissed
          ? sql`coalesce(${schema.announcement_reads.dismissed_at}, ${new Date(now).toISOString()}::timestamptz)`
          : sql`${schema.announcement_reads.dismissed_at}`,
      },
    })
}

export async function markAnnouncementRead(
  id: string,
  userId: string,
  dismissed: boolean,
): Promise<void> {
  const [row] = await db
    .select({ id: schema.announcements.id })
    .from(schema.announcements)
    .where(eq(schema.announcements.id, id))
    .limit(1)
  if (!row) throw new AnnouncementOperationError('not_found')
  await markRead(userId, [id], dismissed)
}

export async function markAnnouncementsRead(
  ids: string[],
  userId: string,
  dismissed: boolean,
): Promise<void> {
  await markRead(userId, ids.slice(0, 200), dismissed)
}

export function normalizeAnnouncementLocale(value: string | undefined): AnnouncementLocale {
  return value === 'en' ? 'en' : 'zh'
}

export function isAnnouncementType(value: string | undefined): value is AnnouncementType {
  return value === 'feature' || value === 'improvement' || value === 'notice'
}
