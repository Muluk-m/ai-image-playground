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
async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await authenticatedBffFetch(`${bffBaseUrl()}/api/projects${path}`, {
    ...init,
    cache: 'no-store',
    signal: init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new ProjectRequestError(response.status, body.error ?? 'project_unavailable')
  }
  return response.json() as Promise<T>
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
