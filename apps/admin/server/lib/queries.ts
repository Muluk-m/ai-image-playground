import {
  type DeviceListOptions,
  type ListOperatorAuditsOptions,
  mapTaskListItem,
  type UserListOptions as ReadModelsUserListOptions,
  getDeviceDetail as readDeviceDetail,
  listDevices as readDevices,
  listOperatorAudits as readOperatorAudits,
  getOverview as readOverview,
  getTask as readTask,
  getUserDetail as readUserDetail,
  getUserKpis as readUserKpis,
  listUsers as readUsers,
  getUserTasks as readUserTasks,
  resetUserKpiCacheForTesting,
  USER_KPI_CACHE_MS,
  volumeBucketUnit,
} from '@image-playground/read-models'
import type {
  DeviceDetailResult,
  ListAuditsResult,
  ListDevicesResult,
  ListUsersResult,
  OverviewResult,
  Range,
  SortKey,
  TaskDetail,
  TimeWindow,
  UserDetailResult,
  UserKpis,
  UserTasksResult,
} from '../../contracts'
import { getAdminCapabilities } from '../config'
import { getDbHandle as getHandle } from './db'

export type { DeviceListOptions, ListOperatorAuditsOptions, Range, SortKey }
export type UserListOptions = Omit<ReadModelsUserListOptions, 'billingCreditsEnabled'>
export { mapTaskListItem, resetUserKpiCacheForTesting, USER_KPI_CACHE_MS, volumeBucketUnit }

export function listDevices(
  range: Range,
  sort: SortKey,
  options: DeviceListOptions = {},
): Promise<ListDevicesResult> {
  return readDevices(getHandle(), range, sort, options)
}

export function listUsers(search = '', options: UserListOptions = {}): Promise<ListUsersResult> {
  return readUsers(getHandle(), search, {
    ...options,
    billingCreditsEnabled: getAdminCapabilities().billingCredits,
  })
}

// Keep direct Promise passthrough (non-async wrapper) so concurrent callers share the exact
// in-flight Promise instance from readUserKpis.
export function getUserKpis(now = Date.now(), fresh = false): Promise<UserKpis> {
  return readUserKpis(getHandle(), now, fresh)
}

export function getOverview(range: Range, custom?: TimeWindow): Promise<OverviewResult> {
  return readOverview(getHandle(), range, custom)
}

export function getUserDetail(
  userId: string,
  includeVolume = true,
): Promise<UserDetailResult | null> {
  return readUserDetail(getHandle(), userId, includeVolume)
}

export function getUserTasks(
  userId: string,
  statusFilter: string,
  cursor?: string,
): Promise<UserTasksResult> {
  return readUserTasks(getHandle(), userId, statusFilter, cursor)
}

export function getDeviceDetail(
  deviceId: string,
  range: Range,
  cursor?: string,
): Promise<DeviceDetailResult> {
  return readDeviceDetail(getHandle(), deviceId, range, cursor)
}

export function getTask(taskId: string): Promise<TaskDetail | null> {
  return readTask(getHandle(), taskId)
}

export function listOperatorAudits(options: ListOperatorAuditsOptions): Promise<ListAuditsResult> {
  return readOperatorAudits(getHandle(), options)
}
