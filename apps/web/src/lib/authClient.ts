import {
  type AuthUserView,
  isOAuthProviderId,
  type OAuthProviderView,
} from '@image-playground/shared'
import { isClientCapabilityEnabled } from './clientCapabilities'
import { getRuntimeConfig } from './runtimeConfig'
export const AUTH_SESSION_EXPIRED_EVENT = 'image-playground:auth-session-expired'

export class AuthRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code)
    this.name = 'AuthRequestError'
  }
}

function bffUrl(path: string): string {
  return `${getRuntimeConfig().bff.baseUrl.replace(/\/+$/, '')}${path}`
}

async function parseError(res: Response): Promise<AuthRequestError> {
  try {
    const body = (await res.json()) as { error?: unknown }
    return new AuthRequestError(
      res.status,
      typeof body.error === 'string' ? body.error : `http_${res.status}`,
    )
  } catch {
    return new AuthRequestError(res.status, `http_${res.status}`)
  }
}

async function authJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(bffUrl(path), {
    ...init,
    credentials: 'include',
    headers: {
      accept: 'application/json',
      ...init.headers,
    },
  })
  if (!res.ok) throw await parseError(res)
  return (await res.json()) as T
}

export async function getCurrentUser(): Promise<AuthUserView> {
  const result = await authJson<{ user: AuthUserView }>('/api/auth/me')
  return result.user
}

export async function loginUser(username: string, password: string): Promise<AuthUserView> {
  const result = await authJson<{ user: AuthUserView }>('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  return result.user
}

export async function registerUser(username: string, password: string): Promise<AuthUserView> {
  const result = await authJson<{ user: AuthUserView }>('/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  return result.user
}

/** Returns the providers this deployment has configured. Any malformed answer disables the block. */
export async function fetchOAuthProviders(): Promise<OAuthProviderView[]> {
  try {
    const body = await authJson<{ providers?: unknown }>('/api/auth/oauth/providers')
    if (!Array.isArray(body.providers)) return []
    return body.providers.filter(
      (provider): provider is OAuthProviderView =>
        typeof provider === 'object' &&
        provider !== null &&
        typeof (provider as OAuthProviderView).id === 'string' &&
        isOAuthProviderId((provider as OAuthProviderView).id) &&
        typeof (provider as OAuthProviderView).label === 'string',
    )
  } catch {
    return []
  }
}

export function oauthStartUrl(provider: string): string {
  return bffUrl(`/api/auth/oauth/${provider}/start`)
}

export async function logoutUser(): Promise<void> {
  await authJson<{ ok: true }>('/api/auth/logout', { method: 'POST' })
}

/**
 * 所有受保护 BFF 调用统一带 cookie。运行中收到 401 时通知 AuthGate 立即卸载工作台，
 * 避免每个 queue 调用点各自维护登录状态。
 */
export async function authenticatedBffFetch(
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  const res = await fetch(input, { ...init, credentials: 'include' })
  if (
    res.status === 401 &&
    isClientCapabilityEnabled('accounts:login') &&
    typeof window !== 'undefined'
  ) {
    window.dispatchEvent(new Event(AUTH_SESSION_EXPIRED_EVENT))
  }
  return res
}
