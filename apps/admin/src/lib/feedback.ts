import type {
  FeedbackAdminDetailResponse,
  FeedbackAdminListResponse,
  FeedbackAdminThreadSummary,
  FeedbackMessage,
  FeedbackStatus,
} from '@image-playground/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, apiClient } from './api-client'
import { adminApiUrl } from './runtime-config'

export const FEEDBACK_KEY = ['feedback'] as const

export type FeedbackFilter = 'all' | 'awaiting_reply' | 'open' | 'resolved'

const FEEDBACK_FILTERS: readonly FeedbackFilter[] = ['all', 'awaiting_reply', 'open', 'resolved']

export interface FeedbackSearch {
  filter?: FeedbackFilter
  q?: string
  thread?: string
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
  return out
}

function listQuery(search: FeedbackSearch): string {
  const params = new URLSearchParams()
  if (search.filter && search.filter !== 'all') params.set('filter', search.filter)
  if (search.q) params.set('q', search.q)
  const query = params.toString()
  return query ? `?${query}` : ''
}

export function feedbackAttachmentUrl(messageId: string): string {
  return adminApiUrl(`/api/feedback/attachments/${encodeURIComponent(messageId)}`)
}

export function useFeedbackThreads(search: FeedbackSearch) {
  return useQuery({
    queryKey: [...FEEDBACK_KEY, 'list', search.filter ?? 'all', search.q ?? ''],
    refetchInterval: 30_000,
    queryFn: () => apiClient.get<FeedbackAdminListResponse>(`/api/feedback${listQuery(search)}`),
  })
}

export function useFeedbackThread(threadId: string | undefined) {
  return useQuery({
    queryKey: [...FEEDBACK_KEY, 'detail', threadId],
    enabled: Boolean(threadId),
    refetchInterval: 30_000,
    queryFn: () =>
      apiClient.get<FeedbackAdminDetailResponse>(`/api/feedback/${encodeURIComponent(threadId!)}`),
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
      mutationFn: (input: { threadId: string; status: FeedbackStatus; lastMessageAt: number }) =>
        apiClient.patch<{ thread: FeedbackAdminThreadSummary }>(
          `/api/feedback/${encodeURIComponent(input.threadId)}/status`,
          { status: input.status, lastMessageAt: input.lastMessageAt },
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
    if (code === 'stale_thread') return '会话有新消息，请查看后再更新状态'
    return `操作失败（HTTP ${error.status}）`
  }
  return '操作失败，请重试'
}
