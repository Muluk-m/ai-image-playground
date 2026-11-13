import type { GptDirectAdminView } from '@image-playground/shared'
import { replaceEqualDeep, useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import type {
  AgentPromptFilters,
  AgentPromptsResult,
  GenerationOverviewResult,
  GenerationTaskFilters,
  GenerationTasksResult,
  TodayErrorsResult,
} from '../../contracts'

import { apiClient } from './api-client'
import {
  type GenerationSelection,
  generationRefreshInterval,
  generationWindow,
} from './generation-overview'
import type {
  ClientErrorEventsResult,
  ClientErrorsResult,
  DeviceDetailResult,
  ListAuditsResult,
  ListDevicesResult,
  ListUsersResult,
  OperatorSettingsResult,
  OpsRange,
  OpsSnapshot,
  Range,
  SortKey,
  TaskDetail,
  UserDetailResult,
  UserTasksResult,
} from './types'

export const ADMIN_REFRESH_EVENT = 'admin:refresh'

export const gptDirectQueryKey = ['gpt-direct'] as const

export function useGptDirect(days: 7 | 30, enabled = true) {
  return useQuery({
    queryKey: [...gptDirectQueryKey, days],
    queryFn: () => apiClient.get<GptDirectAdminView>(`/api/gpt-direct?days=${days}`),
    enabled,
  })
}

export function createGptDirectKey(body: { apiKey: string; budgetUsd: number }) {
  return apiClient.post<GptDirectAdminView>('/api/gpt-direct/keys', body)
}

export function updateGptDirectKey(id: string, body: { budgetUsd?: number; enabled?: boolean }) {
  return apiClient.patch<GptDirectAdminView>(`/api/gpt-direct/keys/${id}`, body)
}

export function reorderGptDirectKeys(ids: string[], revision: number) {
  return apiClient.post<GptDirectAdminView>('/api/gpt-direct/keys/order', { ids, revision })
}

export function deleteGptDirectKey(id: string) {
  return apiClient.del<GptDirectAdminView>(`/api/gpt-direct/keys/${id}`)
}

export function restoreGptDirectKey(fingerprint: string) {
  return apiClient.post<GptDirectAdminView>(`/api/gpt-direct/keys/${fingerprint}/restore`)
}

export function useDevices(
  range: Range,
  sort: SortKey,
  options: { q?: string; page?: number; pageSize?: number; from?: number; to?: number } = {},
) {
  return useQuery({
    queryKey: ['devices', { range, sort, ...options }],
    queryFn: () => {
      const params = new URLSearchParams({ range, sort })
      if (options.q) params.set('q', options.q)
      if (options.page) params.set('page', String(options.page))
      if (options.pageSize) params.set('pageSize', String(options.pageSize))
      if (options.from !== undefined) params.set('from', String(options.from))
      if (options.to !== undefined) params.set('to', String(options.to))
      return apiClient.get<ListDevicesResult>(`/api/devices?${params}`)
    },
  })
}

// cursor 分页：useInfiniteQuery 累积每页 tasks。设备聚合卡片只在首页（pages[0].device）返回。
export function useDeviceDetail(deviceId: string, range: Range) {
  return useInfiniteQuery({
    queryKey: ['device', deviceId, { range }],
    queryFn: ({ pageParam }) =>
      apiClient.get<DeviceDetailResult>(
        `/api/devices/${encodeURIComponent(deviceId)}?range=${range}${
          pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''
        }`,
      ),
    initialPageParam: '',
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: deviceId.length > 0,
  })
}

export function useTask(taskId: string | undefined) {
  return useQuery({
    queryKey: ['task', taskId],
    queryFn: () => apiClient.get<TaskDetail>(`/api/tasks/${encodeURIComponent(taskId!)}`),
    enabled: typeof taskId === 'string' && taskId.length > 0,
  })
}

export interface UserListOptions {
  status?: 'active' | 'disabled'
  registeredFrom?: number
  registeredTo?: number
  activeFrom?: number
  activeTo?: number
  sort?: 'activity' | 'created' | 'login'
  dir?: 'asc' | 'desc'
  page?: number
  pageSize?: 50 | 100
}

export function useUsers(search: string, options: UserListOptions = {}) {
  return useQuery({
    queryKey: ['users', { search, ...options }],
    queryFn: () => {
      const params = new URLSearchParams()
      if (search) params.set('q', search)
      for (const [key, value] of Object.entries(options)) {
        if (value !== undefined) params.set(key, String(value))
      }
      const query = params.toString()
      return apiClient.get<ListUsersResult>(`/api/users${query ? `?${query}` : ''}`)
    },
  })
}

// 档案（聚合 + 趋势）与任务列表分开取：切状态页签只重拉任务，不重算聚合与 30 天趋势。
export function useUserDetail(userId: string) {
  return useQuery({
    queryKey: ['user', userId],
    queryFn: () => apiClient.get<UserDetailResult>(`/api/users/${encodeURIComponent(userId)}`),
    enabled: userId.length > 0,
  })
}

export function useUserTasks(userId: string, status: string) {
  return useInfiniteQuery({
    queryKey: ['user', userId, 'tasks', { status }],
    queryFn: ({ pageParam }) =>
      apiClient.get<UserTasksResult>(
        `/api/users/${encodeURIComponent(userId)}/tasks?status=${encodeURIComponent(status)}${
          pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''
        }`,
      ),
    initialPageParam: '',
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: userId.length > 0,
  })
}

/** 看板默认 30 秒重拉；范围切换只改变宿主机趋势，其他实时块仍取同一份快照。 */
export function useOps(range: OpsRange, refetchInterval = 30_000) {
  return useQuery({
    queryKey: ['ops', { range }],
    queryFn: () => apiClient.get<OpsSnapshot>(`/api/ops?range=${range}`),
    refetchInterval,
  })
}

export interface AuditFilters {
  /** 精确匹配 `operator_audits.action`；空串表示不筛。 */
  action?: string
  settingKey?: string
  targetId?: string
  operatorId?: string
  from?: number
  to?: number
}

/** 审计流按 (created_at, id) keyset 翻页，跟用户任务列表同一套游标约定。 */
export function useAudits(filters: AuditFilters) {
  const params = new URLSearchParams()
  if (filters.action) params.set('action', filters.action)
  if (filters.settingKey) params.set('settingKey', filters.settingKey)
  if (filters.targetId) params.set('targetId', filters.targetId)
  if (filters.operatorId) params.set('operatorId', filters.operatorId)
  if (filters.from !== undefined) params.set('from', String(filters.from))
  if (filters.to !== undefined) params.set('to', String(filters.to))
  return useInfiniteQuery({
    queryKey: ['audits', filters],
    queryFn: ({ pageParam }) => {
      const search = new URLSearchParams(params)
      if (pageParam) search.set('cursor', pageParam)
      return apiClient.get<ListAuditsResult>(`/api/audits?${search.toString()}`)
    },
    initialPageParam: '',
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  })
}

export function useClientErrors(range: Range) {
  return useQuery({
    queryKey: ['client-errors', { range }],
    queryFn: () => apiClient.get<ClientErrorsResult>(`/api/client-errors?range=${range}`),
    refetchInterval: 60_000,
  })
}

export function useClientErrorEvents(fingerprint: string | undefined, range: Range) {
  return useQuery({
    queryKey: ['client-errors', fingerprint, { range }],
    queryFn: () =>
      apiClient.get<ClientErrorEventsResult>(
        `/api/client-errors/${encodeURIComponent(fingerprint!)}?range=${range}`,
      ),
    enabled: typeof fingerprint === 'string' && fingerprint.length > 0,
    // 全局默认 staleTime 是 Infinity；明细要跟列表一起刷新，重新打开同一问题也要重拉。
    staleTime: 0,
    refetchInterval: 60_000,
  })
}

export function useGenerationOverview(selection: GenerationSelection) {
  return useQuery({
    queryKey: ['overview-generation', selection],
    queryFn: () => {
      const window = generationWindow(selection)
      const params = new URLSearchParams({ from: String(window.from), to: String(window.to) })
      return apiClient.get<GenerationOverviewResult>(`/api/overview/generation?${params}`)
    },
    staleTime: 0,
    refetchInterval: generationRefreshInterval(selection),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
}
export function useTodayErrors() {
  return useQuery({
    queryKey: ['overview-errors'],
    queryFn: () => apiClient.get<TodayErrorsResult>('/api/overview/errors'),
    refetchInterval: 30_000,
  })
}

/** The rolling window owns refreshes; changing it creates exactly one new task query. */
export function useGenerationTasksClock(live: boolean) {
  const activatedAt = useMemo(() => ({ live, now: Date.now() }), [live])
  const [clock, setClock] = useState(activatedAt)
  useEffect(() => {
    setClock((previous) => (previous.live === live ? previous : activatedAt))
    if (!live) return
    let timer: number | undefined
    const advance = () =>
      setClock((previous) => ({ live, now: Math.max(Date.now(), previous.now + 1) }))
    const schedule = () => {
      if (timer !== undefined) window.clearInterval(timer)
      timer = undefined
      if (document.visibilityState !== 'hidden') timer = window.setInterval(advance, 30_000)
    }
    const visibilityChanged = () => {
      if (document.visibilityState !== 'hidden') advance()
      schedule()
    }
    const refresh = (event: Event) => {
      event.preventDefault()
      advance()
    }
    schedule()
    document.addEventListener('visibilitychange', visibilityChanged)
    window.addEventListener(ADMIN_REFRESH_EVENT, refresh)
    return () => {
      if (timer !== undefined) window.clearInterval(timer)
      document.removeEventListener('visibilitychange', visibilityChanged)
      window.removeEventListener(ADMIN_REFRESH_EVENT, refresh)
    }
  }, [live, activatedAt])
  return clock.live === live ? clock.now : activatedAt.now
}
export function useGenerationTasks(filters: GenerationTaskFilters) {
  return useQuery({
    queryKey: ['generation-tasks', filters],
    queryFn: () => {
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(filters)) {
        if (value === undefined) continue
        params.set(key, Array.isArray(value) ? value.join(',') : String(value))
      }
      return apiClient.get<GenerationTasksResult>(`/api/tasks?${params}`)
    },
    staleTime: 0,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
}

export function useAgentPrompts(filters: AgentPromptFilters) {
  return useInfiniteQuery({
    queryKey: ['agent-prompts', filters],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(filters))
        if (value !== undefined) params.set(key, String(value))
      if (pageParam) params.set('cursor', pageParam)
      return apiClient.get<AgentPromptsResult>(`/api/agent-prompts?${params}`)
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 0,
  })
}

export const operatorSettingsQueryKey = ['operator-settings'] as const

export function useOperatorSettings() {
  return useQuery({
    queryKey: operatorSettingsQueryKey,
    queryFn: () => apiClient.get<OperatorSettingsResult>('/api/operator-settings'),
    structuralSharing: (previous, incoming) => {
      if (
        previous &&
        typeof previous === 'object' &&
        'revision' in previous &&
        incoming &&
        typeof incoming === 'object' &&
        'revision' in incoming &&
        typeof previous.revision === 'number' &&
        typeof incoming.revision === 'number' &&
        previous.revision > incoming.revision
      )
        return previous
      return replaceEqualDeep(previous, incoming)
    },
  })
}

export function saveOperatorSetting(
  key: string,
  body: { value: boolean | number; reason: string; expectedRevision: number },
) {
  return apiClient.put<OperatorSettingsResult>(
    `/api/operator-settings/${encodeURIComponent(key)}`,
    body,
  )
}

export const upstreamSecretsQueryKey = ['upstream-secrets'] as const

export interface UpstreamSecretView {
  id: 'openai_direct' | 'gemini' | 'vertex' | 'sub2api'
  label: string
  configured: boolean
  source: 'admin' | 'env' | 'unset'
  updatedAt: number | null
  updatedBy: string | null
}

export interface UpstreamSecretsResult {
  writable: boolean
  disabledReason: string | null
  warning: string | null
  secrets: UpstreamSecretView[]
}

export function useUpstreamSecrets() {
  return useQuery({
    queryKey: upstreamSecretsQueryKey,
    queryFn: () => apiClient.get<UpstreamSecretsResult>('/api/upstream-secrets'),
  })
}

export function replaceUpstreamSecret(id: string, apiKey: string) {
  return apiClient.put<UpstreamSecretsResult>(`/api/upstream-secrets/${encodeURIComponent(id)}`, {
    apiKey,
  })
}

export function clearUpstreamSecret(id: string) {
  return apiClient.del<UpstreamSecretsResult>(`/api/upstream-secrets/${encodeURIComponent(id)}`)
}

export function testUpstreamSecret(id: string, apiKey: string) {
  return apiClient.post<{ ok: boolean; httpStatus: number | null }>(
    `/api/upstream-secrets/${encodeURIComponent(id)}/test`,
    { apiKey },
  )
}

export function clearOperatorSetting(
  key: string,
  body: { reason: string; expectedRevision: number },
) {
  return apiClient.del<OperatorSettingsResult>(
    `/api/operator-settings/${encodeURIComponent(key)}?${new URLSearchParams({ reason: body.reason, expectedRevision: String(body.expectedRevision) })}`,
  )
}
