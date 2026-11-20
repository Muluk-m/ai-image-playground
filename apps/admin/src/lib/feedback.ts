import type {
  FeedbackAdminDetailResponse,
  FeedbackAdminListResponse,
  FeedbackAdminThreadSummary,
  FeedbackMessage,
  FeedbackStatus,
} from '@image-playground/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, apiClient } from './api-client'

export const FEEDBACK_KEY = ['feedback'] as const

export type FeedbackFilter = 'all' | 'awaiting_reply' | 'open' | 'resolved'

const FEEDBACK_FILTERS: readonly FeedbackFilter[] = ['all', 'awaiting_reply', 'open', 'resolved']

export interface FeedbackSearch {
  filter?: FeedbackFilter
  q?: string
  thread?: string
  page?: number
  before?: number
}

export function parseFeedbackSearch(input: Record<string, unknown>): FeedbackSearch {
  const out: FeedbackSearch = {}
  if (
    typeof input.filter === 'string' &&
    FEEDBACK_FILTERS.includes(input.filter as FeedbackFilter) &&
    input.filter !== 'all'
  ) {
    out.filter = input.filter as FeedbackFilter
  }
  if (typeof input.q === 'string') {
    const q = input.q.trim().slice(0, 128)
    if (q) out.q = q
  }
  if (typeof input.thread === 'string') {
    const thread = input.thread.trim().slice(0, 128)
    if (thread) out.thread = thread
  }
  if (
    typeof input.page === 'number' &&
    Number.isInteger(input.page) &&
    input.page > 1 &&
    input.page <= 1_000_000
  )
    out.page = input.page
  if (
    typeof input.before === 'number' &&
    Number.isSafeInteger(input.before) &&
    input.before > 0 &&
    input.before <= 8_640_000_000_000_000
  )
    out.before = input.before
  return out
}

function listQuery(search: FeedbackSearch): string {
  const params = new URLSearchParams()
  if (search.filter && search.filter !== 'all') params.set('filter', search.filter)
  if (search.q) params.set('q', search.q)
  if (search.page) params.set('page', String(search.page))
  const query = params.toString()
  return query ? `?${query}` : ''
}

export function fetchFeedbackAttachment(messageId: string, signal: AbortSignal): Promise<Blob> {
  return apiClient.getBlob(`/api/feedback/attachments/${encodeURIComponent(messageId)}`, signal)
}

export function useFeedbackThreads(search: FeedbackSearch) {
  return useQuery({
    queryKey: [...FEEDBACK_KEY, 'list', search.filter ?? 'all', search.q ?? '', search.page ?? 1],
    refetchInterval: 30_000,
    queryFn: () => apiClient.get<FeedbackAdminListResponse>(`/api/feedback${listQuery(search)}`),
  })
}

export function useFeedbackThread(
  threadId: string | undefined,
  before: number | undefined,
  revision: number | undefined,
) {
  return useQuery({
    queryKey: [
      ...FEEDBACK_KEY,
      'detail',
      threadId,
      before,
      before === undefined ? revision : undefined,
    ],
    enabled: Boolean(threadId),
    queryFn: () =>
      apiClient.get<FeedbackAdminDetailResponse>(
        `/api/feedback/${encodeURIComponent(threadId ?? '')}${before === undefined ? '' : `?before=${before}`}`,
      ),
  })
}

export function useFeedbackMutations() {
  const queryClient = useQueryClient()
  const refresh = async (threadId: string) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: [...FEEDBACK_KEY, 'list'] }),
      queryClient.invalidateQueries({ queryKey: [...FEEDBACK_KEY, 'detail', threadId] }),
    ])
  }
  return {
    reply: useMutation({
      mutationFn: (input: { threadId: string; body: string }) =>
        apiClient.post<{ thread: FeedbackAdminThreadSummary; message: FeedbackMessage }>(
          `/api/feedback/${encodeURIComponent(input.threadId)}/replies`,
          { body: input.body },
        ),
      onSuccess: (_data, variables) => refresh(variables.threadId),
    }),
    setStatus: useMutation({
      mutationFn: (input: { threadId: string; status: FeedbackStatus; updatedAt: number }) =>
        apiClient.patch<{ thread: FeedbackAdminThreadSummary }>(
          `/api/feedback/${encodeURIComponent(input.threadId)}/status`,
          { status: input.status, updatedAt: input.updatedAt },
        ),
      onSuccess: (_data, variables) => refresh(variables.threadId),
      onError: async (error, variables) => {
        if (error instanceof ApiError && error.status === 409) await refresh(variables.threadId)
      },
    }),
  }
}

export function formatFeedbackTime(timestamp: number): string {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(timestamp))
  } catch {
    return ''
  }
}

export function feedbackErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const code =
      error.body && typeof error.body === 'object' && 'error' in error.body
        ? String((error.body as { error: unknown }).error)
        : null
    if (code === 'empty_message') return '回复内容不能为空'
    if (code === 'body_too_long') return '回复内容不能超过 4000 字'
    if (code === 'not_found') return '该反馈会话不存在'
    if (code === 'stale_thread') return '会话有更新，请查看后再更新状态'
    return `操作失败（HTTP ${error.status}）`
  }
  return '操作失败，请重试'
}
