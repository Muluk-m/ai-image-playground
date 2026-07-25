import { useInfiniteQuery, useQuery } from '@tanstack/react-query'

import { apiClient } from './api-client'
import type {
  DeviceDetailResult,
  ListDevicesResult,
  ListUsersResult,
  Range,
  SortKey,
  TaskDetail,
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

export function useUsers() {
  return useQuery({
    queryKey: ['users'],
    queryFn: () => apiClient.get<ListUsersResult>('/api/users'),
  })
}
