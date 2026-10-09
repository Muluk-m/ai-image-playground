import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import type {
  GenerationTaskFilters,
  GenerationTasksResult,
  TodayErrorsResult,
  TodayOverviewResult,
} from '../../contracts'

import { apiClient } from './api-client'
import type {
  ClientErrorEventsResult,
  ClientErrorsResult,
  DeviceDetailResult,
  ListAuditsResult,
  ListDevicesResult,
  ListUsersResult,
  OpsRange,
  OpsSnapshot,
  OverviewResult,
  Range,
  SortKey,
  TaskDetail,
  UserDetailResult,
  UserTasksResult,
} from './types'

export const ADMIN_REFRESH_EVENT = 'admin:refresh'

export function useDevices(range: Range, sort: SortKey) {
  return useQuery({
    queryKey: ['devices', { range, sort }],
    queryFn: () => apiClient.get<ListDevicesResult>(`/api/devices?range=${range}&sort=${sort}`),
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

export function useUsers(search: string) {
  return useQuery({
    queryKey: ['users', { search }],
    queryFn: () =>
      apiClient.get<ListUsersResult>(
        `/api/users${search ? `?q=${encodeURIComponent(search)}` : ''}`,
      ),
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

export function useOverview(range: Range) {
  return useQuery({
    queryKey: ['overview', { range }],
    queryFn: () => apiClient.get<OverviewResult>(`/api/overview?range=${range}`),
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
  targetId?: string
}

/** 审计流按 (created_at, id) keyset 翻页，跟用户任务列表同一套游标约定。 */
export function useAudits(filters: AuditFilters) {
  const params = new URLSearchParams()
  if (filters.action) params.set('action', filters.action)
  if (filters.targetId) params.set('targetId', filters.targetId)
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

export function useTodayOverview() {
  return useQuery({
    queryKey: ['overview-today'],
    queryFn: () => apiClient.get<TodayOverviewResult>('/api/overview/today'),
    refetchInterval: 30_000,
  })
}
export function useTodayErrors() {
  return useQuery({
    queryKey: ['overview-errors'],
    queryFn: () => apiClient.get<TodayErrorsResult>('/api/overview/errors'),
    refetchInterval: 30_000,
  })
}
export function useGenerationTasks(filters: GenerationTaskFilters) {
  return useInfiniteQuery({
    queryKey: ['generation-tasks', filters],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(filters))
        if (value !== undefined) params.set(key, String(value))
      if (pageParam) params.set('cursor', pageParam)
      return apiClient.get<GenerationTasksResult>(`/api/tasks?${params}`)
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 0,
  })
}
