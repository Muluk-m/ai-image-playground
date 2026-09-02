import { useInfiniteQuery, useQuery } from '@tanstack/react-query'

import { apiClient } from './api-client'
import type {
  DeviceDetailResult,
  ListDevicesResult,
  ListUsersResult,
  OverviewResult,
  Range,
  SortKey,
  TaskDetail,
  UserDetailResult,
} from './types'

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

export function useUserDetail(userId: string, status: string) {
  return useInfiniteQuery({
    queryKey: ['user', userId, { status }],
    queryFn: ({ pageParam }) =>
      apiClient.get<UserDetailResult>(
        `/api/users/${encodeURIComponent(userId)}?status=${status}${
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
