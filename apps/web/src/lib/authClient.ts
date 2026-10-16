import {
  type AuthUserView,
  type LoginMethodsView,
  OAUTH_SESSION_QUERY_PARAM,
  type OAuthProviderView,
  USER_SESSION_HINT_COOKIE,
} from '@image-playground/shared'
import { accountRequired, isSignedIn } from '../auth/loginPrompt'
import { readProjectRoute } from '../features/canvas/lib/projectRoute'
import { APP_MODE_PATHS, isStandalonePath, normalizePath } from './appPaths'
import {
  applySessionCapabilityGrants,
  isClientCapabilityEnabled,
  readSessionCapabilityGrants,
} from './clientCapabilities'
import { hasRememberedSignedInUser, rememberStorageUser } from './localRecovery'
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

export async function getCurrentUser(signal?: AbortSignal): Promise<AuthUserView> {
  const result = await authJson<{ user: AuthUserView; canvasCapabilities?: unknown }>(
    '/api/auth/me',
    { signal },
  )
  applySessionCapabilityGrants(readSessionCapabilityGrants(result.canvasCapabilities))
  return result.user
}

export async function loginUser(username: string, password: string): Promise<AuthUserView> {
  const result = await authJson<{ user: AuthUserView }>('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  noteBrowserSession(result.user.id)
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
  noteBrowserSession(result.user.id)
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

/** Keep OAuth on the current workspace, never on the marketing or login entry. */
function oauthReturnTo(): string {
  if (typeof window === 'undefined') return APP_MODE_PATHS.image
  const { pathname, search, hash } = window.location
  const path = normalizePath(pathname)
  const workspace =
    Object.values(APP_MODE_PATHS).some((entry) => entry === path) ||
    isStandalonePath(path) ||
    readProjectRoute(pathname) !== null
  const target = `${pathname}${search}${hash}`
  return workspace && target.length <= 2048 && !/[\\\u0000-\u001f\u007f]/.test(target)
    ? target
    : APP_MODE_PATHS.image
}

export function oauthStartUrl(provider: string, referralCode?: string): string {
  const code = referralCode?.trim()
  return bffUrl(
    `/api/auth/oauth/${provider}/start?return_to=${encodeURIComponent(oauthReturnTo())}${code ? `&ref=${encodeURIComponent(code)}` : ''}`,
  )
}

export async function logoutUser(): Promise<void> {
  await authJson<{ ok: true }>('/api/auth/logout', { method: 'POST' })
  applySessionCapabilityGrants(null)
  noteBrowserSession(null)
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
  return bffUrl(`/api/auth/oauth/${provider}/link?return_to=${encodeURIComponent(oauthReturnTo())}`)
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
function requestPath(input: string): string {
  try {
    return new URL(input, 'https://bff.local').pathname
  } catch {
    return ''
  }
}

const PAGE_HINT_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

/**
 * 会话 cookie 写在 API 主机上，页面域名的 document.cookie 读不到。
 * 登录成功后在页面自己的源上留一份不含凭据的提示，并记住用户 id，刷新才会去请求 /api/auth/me。
 */
export function noteBrowserSession(userId: string | null): void {
  rememberStorageUser(userId)
  if (typeof document === 'undefined') return
  const secure = globalThis.location?.protocol === 'https:' ? '; Secure' : ''
  document.cookie =
    userId === null
      ? `${USER_SESSION_HINT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure}`
      : `${USER_SESSION_HINT_COOKIE}=1; Path=/; Max-Age=${PAGE_HINT_MAX_AGE_SECONDS}; SameSite=Lax${secure}`
}

/** OAuth 成功落在前端时带的标记。读过就丢掉，避免刷新反复当作新登录。 */
export function clearOAuthSessionLanding(): void {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  if (!url.searchParams.has(OAUTH_SESSION_QUERY_PARAM)) return
  url.searchParams.delete(OAUTH_SESSION_QUERY_PARAM)
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
}

/**
 * 匿名访客没有可读的登录痕迹时，跳过 /api/auth/me。
 * HttpOnly 会话脚本读不到；页面源上的提示 cookie、上次记住的用户 id，
 * 或 OAuth 刚带回的 auth_session 才说明值得探测。
 */
export function shouldProbeSession(): boolean {
  if (typeof window !== 'undefined') {
    const landing = new URLSearchParams(window.location.search).get(OAUTH_SESSION_QUERY_PARAM)
    if (landing === '1') return true
  }
  if (typeof document !== 'undefined') {
    const hinted = document.cookie.split(';').some((part) => {
      const [name, value] = part.trim().split('=')
      return name === USER_SESSION_HINT_COOKIE && Boolean(value)
    })
    if (hinted) return true
  }
  return hasRememberedSignedInUser()
}

export async function authenticatedBffFetch(
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  // 浏览器里，开了账号且未登录时不拉积分账户：overlay 会无条件请求，匿名打开就会 401。
  // bun 下不挡。私有计费 store 的单测跑在 bun test 里，未登录也要拿到 mock 的账户响应。
  const underBun = typeof globalThis !== 'undefined' && 'Bun' in globalThis
  if (!underBun && accountRequired() && requestPath(input) === '/api/billing/account') {
    return new Response(null, { status: 401 })
  }
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
