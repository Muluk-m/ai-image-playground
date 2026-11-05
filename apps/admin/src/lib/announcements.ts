import type {
  AnnouncementAdminItem,
  AnnouncementAudience,
  AnnouncementDraft,
  AnnouncementExportDocument,
  AnnouncementImportance,
  AnnouncementListResult,
  AnnouncementStatus,
  AnnouncementType,
} from '@image-playground/shared'
import {
  ANNOUNCEMENT_STATUSES,
  ANNOUNCEMENT_TYPES,
  announcementExportDocument,
  parseAnnouncementExport,
} from '@image-playground/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, apiClient } from './api-client'

export const ANNOUNCEMENTS_KEY = ['announcements'] as const

export interface AnnouncementSearch {
  status?: AnnouncementStatus
  type?: AnnouncementType
  language?: 'zh' | 'en'
  withinDays?: 7 | 30 | 90
  q?: string
  page?: number
}

const DAYS = [7, 30, 90] as const

export function parseAnnouncementSearch(input: Record<string, unknown>): AnnouncementSearch {
  const out: AnnouncementSearch = {}
  if (ANNOUNCEMENT_STATUSES.some((status) => status === input.status)) {
    out.status = input.status as AnnouncementStatus
  }
  if (ANNOUNCEMENT_TYPES.some((type) => type === input.type))
    out.type = input.type as AnnouncementType
  if (input.language === 'zh' || input.language === 'en') out.language = input.language
  const days = Number(input.withinDays)
  if (DAYS.some((value) => value === days)) out.withinDays = days as 7 | 30 | 90
  if (typeof input.q === 'string') {
    const q = input.q.trim().slice(0, 128)
    if (q) out.q = q
  }
  const page = Number(input.page)
  if (Number.isInteger(page) && page > 1) out.page = page
  return out
}

function listQuery(search: AnnouncementSearch): string {
  const params = new URLSearchParams()
  if (search.status) params.set('status', search.status)
  if (search.type) params.set('type', search.type)
  if (search.language) params.set('language', search.language)
  if (search.withinDays) params.set('withinDays', String(search.withinDays))
  if (search.q) params.set('q', search.q)
  const query = params.toString()
  return query ? `?${query}` : ''
}

export function useAnnouncements(search: AnnouncementSearch) {
  return useQuery({
    queryKey: [...ANNOUNCEMENTS_KEY, search],
    queryFn: () => apiClient.get<AnnouncementListResult>(`/api/announcements${listQuery(search)}`),
  })
}

export function useAnnouncement(id: string | undefined) {
  return useQuery({
    queryKey: [...ANNOUNCEMENTS_KEY, 'item', id],
    enabled: Boolean(id) && id !== 'new',
    queryFn: () =>
      apiClient.get<{ item: AnnouncementAdminItem; webOrigin: string | null }>(
        `/api/announcements/${encodeURIComponent(id!)}`,
      ),
  })
}

export function useAnnouncementMutations() {
  const queryClient = useQueryClient()
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ANNOUNCEMENTS_KEY })
  }
  return {
    create: useMutation({
      mutationFn: (input: AnnouncementDraft) =>
        apiClient.post<{ item: AnnouncementAdminItem }>('/api/announcements', input),
      onSuccess: refresh,
    }),
    update: useMutation({
      mutationFn: (input: { id: string; draft: AnnouncementDraft }) =>
        apiClient.put<{ item: AnnouncementAdminItem }>(
          `/api/announcements/${encodeURIComponent(input.id)}`,
          input.draft,
        ),
      onSuccess: refresh,
    }),
    publish: useMutation({
      mutationFn: (input: { id: string; reason: string; publishAt: number | null }) =>
        apiClient.post<{ item: AnnouncementAdminItem }>(
          `/api/announcements/${encodeURIComponent(input.id)}/publish`,
          { reason: input.reason, publishAt: input.publishAt },
        ),
      onSuccess: refresh,
    }),
    unpublish: useMutation({
      mutationFn: (input: { id: string; reason: string }) =>
        apiClient.post<{ item: AnnouncementAdminItem }>(
          `/api/announcements/${encodeURIComponent(input.id)}/unpublish`,
          { reason: input.reason },
        ),
      onSuccess: refresh,
    }),
    archive: useMutation({
      mutationFn: (input: { id: string; reason: string }) =>
        apiClient.post<{ item: AnnouncementAdminItem }>(
          `/api/announcements/${encodeURIComponent(input.id)}/archive`,
          { reason: input.reason },
        ),
      onSuccess: refresh,
    }),
    importDraft: useMutation({
      mutationFn: (document: AnnouncementExportDocument) =>
        apiClient.post<{ item: AnnouncementAdminItem }>('/api/announcements/import', document),
      onSuccess: refresh,
    }),
  }
}

export function draftFromItem(item: AnnouncementAdminItem): AnnouncementDraft {
  return {
    type: item.type,
    importance: item.importance,
    titleZh: item.titleZh,
    bodyZh: item.bodyZh,
    titleEn: item.titleEn,
    bodyEn: item.bodyEn,
    coverKey: item.coverKey,
    ctaLabel: item.ctaLabel,
    ctaUrl: item.ctaUrl,
    versionTag: item.versionTag,
    audience: item.audience,
    publishAt: item.publishAt,
    expireAt: item.expireAt,
  }
}

export function emptyAnnouncementDraft(): AnnouncementDraft {
  return {
    type: 'feature',
    importance: 'normal',
    titleZh: '',
    bodyZh: '',
    titleEn: null,
    bodyEn: null,
    coverKey: null,
    ctaLabel: null,
    ctaUrl: null,
    versionTag: null,
    audience: 'all',
    publishAt: null,
    expireAt: null,
  }
}

export function exportAnnouncement(item: AnnouncementAdminItem): AnnouncementExportDocument {
  return announcementExportDocument(draftFromItem(item))
}

export function readAnnouncementExport(value: unknown): AnnouncementExportDocument | null {
  const draft = parseAnnouncementExport(value)
  if (!draft) return null
  return announcementExportDocument(draft)
}

export function announcementErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.body && typeof error.body === 'object') {
    const code = (error.body as { error?: unknown }).error
    switch (code) {
      case 'invalid_announcement':
        return '标题、正文或站内链接还不完整'
      case 'invalid_reason':
        return '请填写原因'
      case 'invalid_window':
        return '到期时间要晚于发布时间'
      case 'not_found':
        return '公告不存在'
      default:
        break
    }
  }
  return error instanceof Error ? error.message : '保存失败'
}

export const TYPE_LABEL: Record<AnnouncementType, string> = {
  feature: '新功能',
  improvement: '优化',
  notice: '公告',
}

export const IMPORTANCE_LABEL: Record<AnnouncementImportance, string> = {
  normal: '普通',
  major: '重要 · 弹窗',
}

export const STATUS_LABEL: Record<AnnouncementStatus, string> = {
  draft: '草稿',
  scheduled: '已排期',
  published: '已发布',
  archived: '已归档',
}

export const AUDIENCE_LABEL: Record<AnnouncementAudience, string> = {
  all: '全部用户',
  logged_in: '登录用户',
  anonymous: '未登录',
}

export function epochToLocalInput(ms: number | null): string {
  if (ms == null) return ''
  const date = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function localInputToEpoch(value: string): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

export function formatBeijing(ms: number | null, withTime = true): string {
  if (ms == null) return '—'
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: withTime ? '2-digit' : undefined,
    minute: withTime ? '2-digit' : undefined,
    hourCycle: 'h23',
  }).formatToParts(new Date(ms))
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value
  const day = `${read('month')}-${read('day')}`
  return withTime ? `${day} ${read('hour')}:${read('minute')}` : day
}

export function formatBeijingLong(ms: number): string {
  return `${new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(ms))} 北京时间`
}

export function formatReadRate(rate: number | null): string {
  return rate == null ? '—' : `${rate.toFixed(1)}%`
}
