import type { StageAuthorization, StageAuthorizationPreflight } from '@image-playground/shared'
import { authenticatedBffFetch } from '../../../lib/authClient'
import { bffBaseUrl } from '../../../lib/runtimeConfig'

async function request<T>(id: string, action = '', body?: unknown): Promise<T> {
  const response = await authenticatedBffFetch(
    `${bffBaseUrl()}/api/agent/stage-authorizations/${encodeURIComponent(id)}${action}`,
    {
      method: body === undefined ? 'GET' : 'POST',
      signal: AbortSignal.timeout(15000),
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    },
  )
  if (!response.ok)
    throw Object.assign(new Error('stage_authorization_rejected'), { code: 'authorization' })
  return response.json() as Promise<T>
}
export const stageAuthorizationClient = {
  read: (id: string) => request<StageAuthorization>(id),
  confirm: (id: string) =>
    request<{ authorization: StageAuthorization; executionToken: string }>(id, '/confirm', {}),
  preflight: (id: string, input: StageAuthorizationPreflight) =>
    request<StageAuthorization>(id, '/preflight', input),
  end: (id: string) => request<StageAuthorization>(id, '/end', {}),
}
