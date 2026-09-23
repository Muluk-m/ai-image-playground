import type {
  AgentConversationView,
  CloudProject,
  CloudProjectSummary,
  ProjectPage,
  ProjectTrashPage,
  ProjectWrite,
} from '@image-playground/shared'
import { authenticatedBffFetch } from '../../../lib/authClient'
import { isUserStorageScope } from '../../../lib/authScope'
import { isClientCapabilityEnabled } from '../../../lib/clientCapabilities'
import { bffBaseUrl, getRuntimeConfig } from '../../../lib/runtimeConfig'

export function cloudProjectsEnabled(): boolean {
  return (
    getRuntimeConfig().bff.enabled &&
    isUserStorageScope() &&
    isClientCapabilityEnabled('accounts:sync')
  )
}
export class ProjectRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code)
  }
}
/**
 * 30s 不是宽容，是实测：链路抖起来单程 TTFB 能到 8s（服务端 p50 只有 1ms），
 * 旧的 10/15s 阈值会把一次网络抖动变成「项目读不出来」。
 */
export const PROJECT_REQUEST_TIMEOUT_MS = 30000

async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
  const send = async () => {
    const response = await authenticatedBffFetch(`${bffBaseUrl()}/api/projects${path}`, {
      ...init,
      cache: 'no-store',
      signal: init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(PROJECT_REQUEST_TIMEOUT_MS)])
        : AbortSignal.timeout(PROJECT_REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string }
      throw new ProjectRequestError(response.status, body.error ?? 'project_unavailable')
    }
    return response.json() as Promise<T>
  }
  try {
    return await send()
  } catch (error) {
    // 读是幂等的，抖一次就再要一遍；写（PUT/POST/DELETE）可能已经落库，只能交给调用方。
    // 只重试没到达服务端的失败：超时、断网。带 HTTP 状态的一概不重试。
    // 按 name 认而不是按类认：AbortError/TimeoutError 可能来自别的 realm（polyfill、
    // 测试环境），`instanceof DOMException` 在那里会漏判。TypeError 是 fetch 的断网。
    const name = error instanceof Error ? error.name : ''
    const transport = name === 'AbortError' || name === 'TimeoutError' || error instanceof TypeError
    if (init.method && init.method !== 'GET') throw error
    if (init.signal?.aborted || !transport) throw error
    return send()
  }
}
export function listCloudProjects(cursor?: string): Promise<ProjectPage> {
  return json(cursor ? `?cursor=${encodeURIComponent(cursor)}` : '')
}
export function getCloudProject(id: string, signal: AbortSignal): Promise<CloudProject> {
  return json(`/${encodeURIComponent(id)}`, { signal })
}
export function putCloudProject(
  id: string,
  body: ProjectWrite,
  signal: AbortSignal,
): Promise<CloudProjectSummary> {
  return json(`/${encodeURIComponent(id)}`, {
    method: 'PUT',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function ensureCloudProjectConversation(
  id: string,
  conversationId?: string,
): Promise<{ conversation: AgentConversationView }> {
  return json(`/${encodeURIComponent(id)}/conversation`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(conversationId ? { conversationId } : {}),
  })
}

export function deleteCloudProject(id: string): Promise<{ ok: true }> {
  return json(`/${encodeURIComponent(id)}`, { method: 'DELETE' })
}
export function restoreDeletedCloudProject(id: string): Promise<{ ok: true }> {
  return json(`/${encodeURIComponent(id)}/restore`, { method: 'POST' })
}
export function listRecycledCloudProjects(cursor?: string): Promise<ProjectTrashPage> {
  return json(`/trash${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`)
}
