import type { AuthUserView, LoginMethodsView, OAuthProviderView } from '@image-playground/shared'
import { isSignedIn } from '../auth/loginPrompt'
import { isClientCapabilityEnabled } from './clientCapabilities'
import { bffBaseUrl } from './runtimeConfig'
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
  return `${bffBaseUrl()}${path}`
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
export interface RegistrationVerificationChallenge {
  challengeId: string
  expiresInSeconds: number
}

export async function requestRegistrationVerification(
  email: string,
): Promise<RegistrationVerificationChallenge> {
  const result = await authJson<{ challenge_id: string; expires_in_seconds: number }>(
    '/api/auth/register/verification',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    },
  )
  return {
    challengeId: result.challenge_id,
    expiresInSeconds: result.expires_in_seconds,
  }
}

export async function registerUser(
  username: string,
  password: string,
  options: {
    referralCode?: string
    verification?: { challengeId: string; code: string }
  } = {},
): Promise<AuthUserView> {
  const result = await authJson<{ user: AuthUserView }>('/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username,
      password,
      referral_code: options.referralCode?.trim() || undefined,
      verification_id: options.verification?.challengeId,
      verification_code: options.verification?.code,
    }),
  })
  return result.user
}

/**
 * The BFF is the authority on which providers exist, so this validates the wire shape only —
 * an id this bundle predates must still reach the login page.
 */
export async function fetchOAuthProviders(): Promise<OAuthProviderView[]> {
  try {
    const body = await authJson<{ providers?: unknown }>('/api/auth/oauth/providers')
    if (!Array.isArray(body.providers)) return []
    return body.providers.filter((provider): provider is OAuthProviderView => {
      const view = provider as Partial<OAuthProviderView> | null
      return typeof view?.id === 'string' && typeof view.label === 'string'
    })
  } catch {
    return []
  }
}

export function oauthStartUrl(provider: string, referralCode?: string): string {
  const code = referralCode?.trim()
  return bffUrl(
    `/api/auth/oauth/${provider}/start${code ? `?ref=${encodeURIComponent(code)}` : ''}`,
  )
}

export async function logoutUser(): Promise<void> {
  await authJson<{ ok: true }>('/api/auth/logout', { method: 'POST' })
}

export async function fetchLoginMethods(): Promise<LoginMethodsView> {
  return authJson<LoginMethodsView>('/api/auth/login-methods')
}

export async function updateOwnPassword(input: {
  currentPassword?: string
  newPassword: string
}): Promise<void> {
  await authJson<{ ok: true }>('/api/auth/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...(input.currentPassword ? { current_password: input.currentPassword } : {}),
      new_password: input.newPassword,
    }),
  })
}

export function oauthLinkUrl(provider: string): string {
  return bffUrl(`/api/auth/oauth/${provider}/link`)
}

export async function unlinkOAuthProvider(provider: string): Promise<void> {
  await authJson<{ ok: true }>(`/api/auth/oauth/${provider}/link`, { method: 'DELETE' })
}

/**
 * 所有受保护 BFF 调用统一带 cookie。运行中收到 401 时通知 AuthGate 提示重新登录，
 * 避免每个 queue 调用点各自维护登录状态。
 *
 * 只有「本来登着」才算会话失效：未登录访客也能进工作台，他们的 401 是正常的权限边界，
 * 由动作自己在发请求前调 requireAccount() 弹登录框，这里再喊一次只会冒出第二个弹窗。
 */
export async function authenticatedBffFetch(
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  const res = await fetch(input, { ...init, credentials: 'include' })
  if (
    res.status === 401 &&
    isSignedIn() &&
    isClientCapabilityEnabled('accounts:login') &&
    typeof window !== 'undefined'
  ) {
    window.dispatchEvent(new Event(AUTH_SESSION_EXPIRED_EVENT))
  }
  return res
}
