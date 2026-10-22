import type {
  StageAuthorization,
  StageAuthorizationPreflight,
  StageRunNodeReport,
  StageRunReportInput,
  StageRunReportResult,
  StageRunWakeReceipt,
} from '@image-playground/shared'
import { authenticatedBffFetch } from '../../../lib/authClient'
import { getDeviceId } from '../../../lib/deviceId'
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
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw Object.assign(new Error(body?.error ?? 'stage_authorization_rejected'), {
      code: body?.error === 'stage_authorization_stale' ? 'stale' : 'authorization',
    })
  }
  return response.json() as Promise<T>
}
export const stageAuthorizationClient = {
  read: (id: string) => request<StageAuthorization>(id),
  confirm: (
    id: string,
    charges?: readonly {
      nodeId: string
      model: string
      quantity: number
      unitMultiplier: number
    }[],
  ) =>
    request<{ authorization: StageAuthorization; executionToken: string }>(
      id,
      '/confirm',
      charges?.length ? { charges } : {},
    ),
  preflight: (id: string, input: StageAuthorizationPreflight) =>
    request<StageAuthorization>(id, '/preflight', input),
  end: (id: string) => request<StageAuthorization>(id, '/end', {}),
  /** 一批运行的结局交给 BFF，它结束授权并唤醒智能体一次；重复上报不会再唤醒。 */
  report: (id: string, input: StageRunReportInput) =>
    request<{ authorization: StageAuthorization } & StageRunReportResult>(id, '/report', {
      ...input,
      deviceId: getDeviceId(),
    }),
  /** 需要确认的卡开跑前被拦下：只让服务端记一条日志，不结束授权、不唤醒。 */
  blocked: (id: string, nodes: readonly StageRunNodeReport[]) =>
    request<{ logged: true }>(id, '/blocked', { nodes }),
  /** 这条授权的回报唤醒走到了哪一步；服务端还没收到回报时抛错（404）。 */
  wake: (id: string) => request<StageRunWakeReceipt>(id, '/wake'),
}
