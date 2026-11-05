/**
 * 版本公告。付费 / 免费投放要等公开树能读到订阅状态（私有 overlay 的 isActiveMember）。
 * 在那之前投放对象只有 all / logged_in / anonymous。
 */

export const ANNOUNCEMENT_TYPES = ['feature', 'improvement', 'notice'] as const
export type AnnouncementType = (typeof ANNOUNCEMENT_TYPES)[number]

export const ANNOUNCEMENT_IMPORTANCES = ['normal', 'major'] as const
export type AnnouncementImportance = (typeof ANNOUNCEMENT_IMPORTANCES)[number]

export const ANNOUNCEMENT_STATUSES = ['draft', 'scheduled', 'published', 'archived'] as const
export type AnnouncementStatus = (typeof ANNOUNCEMENT_STATUSES)[number]

/** paid / free 暂不入库，见文件头的 TODO。 */
export const ANNOUNCEMENT_AUDIENCES = ['all', 'logged_in', 'anonymous'] as const
export type AnnouncementAudience = (typeof ANNOUNCEMENT_AUDIENCES)[number]

export const ANNOUNCEMENT_LOCALES = ['zh', 'en'] as const
export type AnnouncementLocale = (typeof ANNOUNCEMENT_LOCALES)[number]

export const ANNOUNCEMENT_TITLE_MAX = 80
export const ANNOUNCEMENT_BODY_MAX = 20_000
export const ANNOUNCEMENT_CTA_LABEL_MAX = 40
export const ANNOUNCEMENT_VERSION_MAX = 32
export const ANNOUNCEMENT_REASON_MAX = 500

export const ANNOUNCEMENT_EXPORT_FORMAT = 'muvloom.announcement'
export const ANNOUNCEMENT_EXPORT_VERSION = 1

export interface AnnouncementWindow {
  status: AnnouncementStatus
  publishAt: number | null
  expireAt: number | null
}

/** 排期到点即可见，过期即不可见，不依赖定时任务改写 status。 */
export function effectiveAnnouncementStatus(
  input: AnnouncementWindow,
  now: number,
): AnnouncementStatus {
  if (input.status === 'draft' || input.status === 'archived') return input.status
  if (input.expireAt != null && input.expireAt <= now) return 'archived'
  if (input.publishAt != null && input.publishAt > now) return 'scheduled'
  return 'published'
}

export function announcementIsVisible(input: AnnouncementWindow, now: number): boolean {
  return effectiveAnnouncementStatus(input, now) === 'published'
}

export type AnnouncementViewer = 'anonymous' | 'logged_in'

export function announcementMatchesAudience(
  audience: AnnouncementAudience,
  viewer: AnnouncementViewer,
): boolean {
  if (audience === 'all') return true
  if (audience === 'logged_in') return viewer === 'logged_in'
  return viewer === 'anonymous'
}

export interface AnnouncementCopy {
  titleZh: string
  bodyZh: string
  titleEn?: string | null
  bodyEn?: string | null
}

export interface LocalizedAnnouncement {
  title: string
  body: string
  /** 请求的是英文，但标题或正文至少有一侧回退到中文。 */
  usedFallback: boolean
}

export function localizeAnnouncement(
  copy: AnnouncementCopy,
  locale: AnnouncementLocale,
): LocalizedAnnouncement {
  const titleZh = copy.titleZh.trim()
  const bodyZh = copy.bodyZh.trim()
  if (locale === 'zh') return { title: titleZh, body: bodyZh, usedFallback: false }
  const titleEn = copy.titleEn?.trim() ?? ''
  const bodyEn = copy.bodyEn?.trim() ?? ''
  return {
    title: titleEn || titleZh,
    body: bodyEn || bodyZh,
    usedFallback: !titleEn || !bodyEn,
  }
}

/** 站内路径：以单个 / 开头，不能是协议相对地址或带 scheme 的 URL。 */
export function isInSitePath(value: string): boolean {
  const path = value.trim()
  if (!path.startsWith('/') || path.startsWith('//')) return false
  if (path.includes('\\') || /[\u0000-\u001f\u007f]/.test(path) || /%5c/i.test(path)) return false
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return false
  try {
    const url = new URL(path, 'https://announcements.local')
    return url.origin === 'https://announcements.local'
  } catch {
    return false
  }
}

export interface AnnouncementAdminItem extends AnnouncementDraft {
  id: string
  status: AnnouncementStatus
  effectiveStatus: AnnouncementStatus
  createdBy: string
  updatedBy: string
  createdAt: number
  updatedAt: number
  readCount: number
  /** 匿名投放没有可数的分母。 */
  audienceSize: number | null
  readRate: number | null
  coverUrl: string | null
}

export interface AnnouncementListResult {
  items: AnnouncementAdminItem[]
  counts: Record<AnnouncementStatus | 'all', number>
  /** 当前筛选下的条数。counts 始终是未筛选的有效状态计数。 */
  matched: number
  nextScheduleAt: number | null
  webOrigin: string | null
}

export interface AnnouncementPublicItem {
  id: string
  type: AnnouncementType
  importance: AnnouncementImportance
  title: string
  body: string
  usedFallback: boolean
  coverUrl: string | null
  ctaLabel: string | null
  ctaUrl: string | null
  versionTag: string | null
  publishAt: number | null
  unread: boolean
  dismissed: boolean
}

export interface AnnouncementPublicList {
  items: AnnouncementPublicItem[]
  unreadCount: number
}

export interface AnnouncementDraft {
  type: AnnouncementType
  importance: AnnouncementImportance
  titleZh: string
  bodyZh: string
  titleEn: string | null
  bodyEn: string | null
  coverKey: string | null
  ctaLabel: string | null
  ctaUrl: string | null
  versionTag: string | null
  audience: AnnouncementAudience
  publishAt: number | null
  expireAt: number | null
}

export interface AnnouncementExportDocument {
  format: typeof ANNOUNCEMENT_EXPORT_FORMAT
  version: typeof ANNOUNCEMENT_EXPORT_VERSION
  announcement: AnnouncementDraft
}

export function announcementExportDocument(draft: AnnouncementDraft): AnnouncementExportDocument {
  return {
    format: ANNOUNCEMENT_EXPORT_FORMAT,
    version: ANNOUNCEMENT_EXPORT_VERSION,
    announcement: draft,
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function optionalText(value: unknown, max: number): string | null | undefined {
  if (value == null) return null
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.length > max) return undefined
  return trimmed
}

export function parseAnnouncementDraft(value: unknown): AnnouncementDraft | null {
  const record = asRecord(value)
  if (!record) return null
  if (!ANNOUNCEMENT_TYPES.includes(record.type as AnnouncementType)) return null
  if (!ANNOUNCEMENT_IMPORTANCES.includes(record.importance as AnnouncementImportance)) return null
  if (!ANNOUNCEMENT_AUDIENCES.includes(record.audience as AnnouncementAudience)) return null
  const titleZh = optionalText(record.titleZh, ANNOUNCEMENT_TITLE_MAX)
  const bodyZh = optionalText(record.bodyZh, ANNOUNCEMENT_BODY_MAX)
  const titleEn = optionalText(record.titleEn, ANNOUNCEMENT_TITLE_MAX)
  const bodyEn = optionalText(record.bodyEn, ANNOUNCEMENT_BODY_MAX)
  const coverKey = optionalText(record.coverKey, 2048)
  const ctaLabel = optionalText(record.ctaLabel, ANNOUNCEMENT_CTA_LABEL_MAX)
  const ctaUrl = optionalText(record.ctaUrl, 2048)
  const versionTag = optionalText(record.versionTag, ANNOUNCEMENT_VERSION_MAX)
  if (
    titleZh == null ||
    bodyZh === undefined ||
    titleEn === undefined ||
    bodyEn === undefined ||
    coverKey === undefined ||
    ctaLabel === undefined ||
    ctaUrl === undefined ||
    versionTag === undefined
  ) {
    return null
  }
  if ((ctaLabel == null) !== (ctaUrl == null)) return null
  if (ctaUrl && !isInSitePath(ctaUrl)) return null
  const publishAt = optionalTime(record.publishAt)
  const expireAt = optionalTime(record.expireAt)
  if (publishAt === undefined || expireAt === undefined) return null
  if (publishAt != null && expireAt != null && expireAt <= publishAt) return null
  return {
    type: record.type as AnnouncementType,
    importance: record.importance as AnnouncementImportance,
    titleZh,
    bodyZh: bodyZh ?? '',
    titleEn,
    bodyEn,
    coverKey,
    ctaLabel,
    ctaUrl,
    versionTag,
    audience: record.audience as AnnouncementAudience,
    publishAt,
    expireAt,
  }
}

function optionalTime(value: unknown): number | null | undefined {
  if (value == null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return value
}

export function parseAnnouncementExport(value: unknown): AnnouncementDraft | null {
  const record = asRecord(value)
  if (!record) return null
  if (record.format !== ANNOUNCEMENT_EXPORT_FORMAT) return null
  if (record.version !== ANNOUNCEMENT_EXPORT_VERSION) return null
  return parseAnnouncementDraft(record.announcement)
}

export interface AnnouncementReadFlags {
  id: string
  importance: AnnouncementImportance
  publishAt: number | null
  unread: boolean
  dismissed: boolean
}

/** 重要公告同时只挑一条：最新的、还没看过也没关掉的。 */
export function selectMajorAnnouncement<T extends AnnouncementReadFlags>(
  items: readonly T[],
): T | null {
  const majors = items.filter(
    (item) => item.importance === 'major' && item.unread && !item.dismissed,
  )
  majors.sort((left, right) => (right.publishAt ?? 0) - (left.publishAt ?? 0))
  return majors[0] ?? null
}

export interface LocalAnnouncementRead {
  readAt?: number
  dismissedAt?: number
}

/** 匿名用户的已读记在 localStorage。已登录仍以服务端为准，这里只补匿名。 */
export function applyLocalAnnouncementReads<T extends AnnouncementReadFlags>(
  items: readonly T[],
  local: Readonly<Record<string, LocalAnnouncementRead>>,
  anonymous: boolean,
): T[] {
  if (!anonymous) return [...items]
  return items.map((item) => {
    const entry = local[item.id]
    if (!entry) return item
    const read = entry.readAt != null
    const dismissed = entry.dismissedAt != null
    return {
      ...item,
      unread: item.unread && !read,
      dismissed: item.dismissed || dismissed,
    }
  })
}

export type AnnouncementInline =
  | { type: 'text'; text: string }
  | { type: 'strong'; text: string }
  | { type: 'link'; text: string; href: string }

export type AnnouncementBlock =
  | { type: 'paragraph'; inlines: AnnouncementInline[] }
  | { type: 'heading'; inlines: AnnouncementInline[] }
  | { type: 'list'; items: AnnouncementInline[][] }

function parseInlines(source: string): AnnouncementInline[] {
  const inlines: AnnouncementInline[] = []
  const pattern = /\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*/g
  let cursor = 0
  for (const match of source.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > cursor) inlines.push({ type: 'text', text: source.slice(cursor, index) })
    if (match[3]) inlines.push({ type: 'strong', text: match[3] })
    else {
      const href = match[2] ?? ''
      const text = match[1] ?? ''
      if (isInSitePath(href)) inlines.push({ type: 'link', text, href })
      else inlines.push({ type: 'text', text })
    }
    cursor = index + match[0].length
  }
  if (cursor < source.length) inlines.push({ type: 'text', text: source.slice(cursor) })
  return inlines.filter((inline) => inline.type !== 'text' || inline.text.length > 0)
}

/** `-` / `*` 与 `1.` `1)` 都是列表。序号只负责分段，页上再统一编号。 */
const LIST_LINE = /^\s*(?:[-*]|\d+[.)])\s+/

/** 公告正文只用到标题、段落、列表、加粗和站内链接。 */
export function parseAnnouncementMarkdown(source: string): AnnouncementBlock[] {
  const blocks: AnnouncementBlock[] = []
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (!line.trim()) {
      index += 1
      continue
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line.trim())
    if (heading) {
      blocks.push({ type: 'heading', inlines: parseInlines(heading[2] ?? '') })
      index += 1
      continue
    }
    if (LIST_LINE.test(line)) {
      const items: AnnouncementInline[][] = []
      while (index < lines.length && LIST_LINE.test(lines[index] ?? '')) {
        items.push(parseInlines((lines[index] ?? '').replace(LIST_LINE, '')))
        index += 1
      }
      blocks.push({ type: 'list', items })
      continue
    }
    const paragraph: string[] = []
    while (
      index < lines.length &&
      (lines[index] ?? '').trim() &&
      !LIST_LINE.test(lines[index] ?? '') &&
      !/^#{1,3}\s+/.test((lines[index] ?? '').trim())
    ) {
      paragraph.push((lines[index] ?? '').trim())
      index += 1
    }
    blocks.push({ type: 'paragraph', inlines: parseInlines(paragraph.join(' ')) })
  }
  return blocks
}
