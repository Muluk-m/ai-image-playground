import { useQuery } from '@tanstack/react-query'

import { apiClient } from './api-client'
import type {
  DeviceDetailResult,
  ListDevicesResult,
  Range,
  SortKey,
  TaskDetail,
} from './types'

export function useDevices(range: Range, sort: SortKey) {
  return useQuery({
    queryKey: ['devices', { range, sort }],
    queryFn: () =>
      apiClient.get<ListDevicesResult>(
        `/api/devices?range=${range}&sort=${sort}`,
      ),
  })
}

export function useDeviceDetail(deviceId: string, range: Range) {
  return useQuery({
    queryKey: ['device', deviceId, { range }],
    queryFn: () =>
      apiClient.get<DeviceDetailResult>(
        `/api/devices/${encodeURIComponent(deviceId)}?range=${range}`,
      ),
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
