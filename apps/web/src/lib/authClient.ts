import {
  type AuthUserView,
  type LoginMethodsView,
  OAUTH_SESSION_QUERY_PARAM,
  type OAuthProvidersResponse,
  type OAuthProviderView,
  SESSION_REFRESH_REQUEST_HEADER,
  type SessionRefreshRequestKey,
  USER_SESSION_HINT_COOKIE,
} from '@image-playground/shared'
import { accountRequired, isSignedIn } from '../auth/loginPrompt'
import { readProjectRoute } from '../features/canvas/lib/projectRoute'
import {
  APP_MODE_PATHS,
  isCliConnectPath,
  isStandalonePath,
  normalizePath,
  toolRouteSlug,
} from './appPaths'
import { isClientCapabilityEnabled } from './clientCapabilities'
import { hasRememberedSignedInUser, rememberStorageUser } from './localRecovery'
import { bffBaseUrl } from './runtimeConfig'
import {
  acquireRefreshAttempt,
  clearRefreshJournal,
  completeRefreshAttempt,
} from './sessionRefreshJournal'
export const AUTH_SESSION_EXPIRED_EVENT = 'image-playground:auth-session-expired'
export type LoginMethodsPolicy = OAuthProvidersResponse['loginMethods']
export type LoginOptions = OAuthProvidersResponse

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

const ACCESS_REFRESH_LEAD_MS = 24 * 60 * 60 * 1000
let accessExpiresAt: number | null = null

/** access 剩余不足一天时，打开页面或回到前台就先刷新，避免用到一半才 401。 */
export function accessRefreshDue(now = Date.now()): boolean {
  return accessExpiresAt !== null && accessExpiresAt - now <= ACCESS_REFRESH_LEAD_MS
}

const SESSION_ROTATED_AT_KEY = 'image-playground.session-rotated-at'
const SESSION_ROTATION_INTERVAL_MS = 24 * 60 * 60 * 1000

function writeSessionRotatedAt(value: number | null): void {
  try {
    if (value === null) localStorage.removeItem(SESSION_ROTATED_AT_KEY)
    else localStorage.setItem(SESSION_ROTATED_AT_KEY, String(value))
  } catch {
    // Storage can be blocked; rotation then simply happens on every boot as before.
  }
}

/**
 * 启动时是否该主动轮换一次 refresh：本浏览器一天内没轮换过才轮换。
 * 没有记录（含 11-05 前尚无 refresh 链的旧会话）照常轮换一次，借此完成升级；
 * 之后不再每次打开页面都轮换，降低轮换响应丢失后被判复用而整链作废的机会。
 */
export function sessionRotationDue(now = Date.now()): boolean {
  try {
    const last = Number(localStorage.getItem(SESSION_ROTATED_AT_KEY))
    return !Number.isFinite(last) || last <= 0 || now - last >= SESSION_ROTATION_INTERVAL_MS
  } catch {
    return true
  }
}

export async function getCurrentUser(signal?: AbortSignal): Promise<AuthUserView> {
  const result = await authJson<{ user: AuthUserView; access_expires_at?: unknown }>(
    '/api/auth/me',
    {
      signal,
    },
  )
  accessExpiresAt = typeof result.access_expires_at === 'number' ? result.access_expires_at : null
  return result.user
}

export async function loginUser(username: string, password: string): Promise<AuthUserView> {
  const result = await authJson<{ user: AuthUserView }>('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  await clearRefreshJournal(bffBaseUrl()).catch(() => {})
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
  await clearRefreshJournal(bffBaseUrl()).catch(() => {})
  noteBrowserSession(result.user.id)
  return result.user
}

/** The BFF is authoritative for both provider availability and local form policy. */
export async function fetchLoginOptions(): Promise<LoginOptions> {
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  const query = origin ? `?frontend_origin=${encodeURIComponent(origin)}` : ''
  const body = await authJson<{ providers?: unknown; loginMethods?: unknown }>(
    `/api/auth/oauth/providers${query}`,
  )
  if (!Array.isArray(body.providers)) throw new Error('invalid_login_options')
  const methods = body.loginMethods as Partial<LoginMethodsPolicy> | null
  if (typeof methods?.password !== 'boolean' || typeof methods.registration !== 'boolean') {
    throw new Error('invalid_login_options')
  }
  return {
    providers: body.providers.filter((provider): provider is OAuthProviderView => {
      const view = provider as Partial<OAuthProviderView> | null
      return typeof view?.id === 'string' && typeof view.label === 'string'
    }),
    loginMethods: { password: methods.password, registration: methods.registration },
  }
}

export async function fetchOAuthProviders(): Promise<readonly OAuthProviderView[]> {
  try {
    return (await fetchLoginOptions()).providers
  } catch {
    return []
  }
}

/** Keep OAuth on the current workspace, with an explicit origin for browser navigations. */
function oauthReturnTo(): { target: string; origin: string } {
  if (typeof window === 'undefined') return { target: APP_MODE_PATHS.image, origin: '' }
  const { pathname, search, hash, origin } = window.location
  const path = normalizePath(pathname)
  const workspace =
    Object.values(APP_MODE_PATHS).some((entry) => entry === path) ||
    isStandalonePath(path) ||
    isCliConnectPath(path) ||
    readProjectRoute(pathname) !== null ||
    toolRouteSlug(pathname) !== null
  const target = `${pathname}${search}${hash}`
  return {
    target:
      workspace && target.length <= 2048 && !/[\\\u0000-\u001f\u007f]/.test(target)
        ? target
        : APP_MODE_PATHS.image,
    origin,
  }
}

function oauthQuery(): string {
  const { target, origin } = oauthReturnTo()
  const params = new URLSearchParams({ return_to: target })
  if (origin) params.set('frontend_origin', origin)
  return params.toString()
}

export function oauthStartUrl(provider: string, referralCode?: string): string {
  const params = new URLSearchParams(oauthQuery())
  const code = referralCode?.trim()
  if (code) params.set('ref', code)
  return bffUrl(`/api/auth/oauth/${provider}/start?${params.toString()}`)
}

export async function logoutUser(): Promise<void> {
  await authJson<{ ok: true }>('/api/auth/logout', { method: 'POST' })
  await clearRefreshJournal(bffBaseUrl()).catch(() => {})
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
  return bffUrl(`/api/auth/oauth/${provider}/link?${oauthQuery()}`)
}

export async function unlinkOAuthProvider(provider: string): Promise<void> {
  await authJson<{ ok: true }>(`/api/auth/oauth/${provider}/link`, { method: 'DELETE' })
}

export interface CliConnectionSummary {
  readonly id: string
  readonly client_name: string
  readonly created_at: number
  readonly last_used_at: number | null
}

export async function fetchCliConnections(signal?: AbortSignal): Promise<CliConnectionSummary[]> {
  const res = await authenticatedBffFetch(bffUrl('/api/me/cli-connections'), { signal })
  if (!res.ok) throw await parseError(res)
  const body = (await res.json()) as { connections?: unknown } | null
  // 响应体不符合契约时按加载失败处理，避免账户页渲染时整页白屏。
  const connections = body?.connections
  if (!Array.isArray(connections) || !connections.every(isCliConnectionSummary)) {
    throw new AuthRequestError(res.status, 'invalid_response')
  }
  return connections
}

function isCliConnectionSummary(value: unknown): value is CliConnectionSummary {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return (
    typeof row.id === 'string' &&
    typeof row.client_name === 'string' &&
    typeof row.created_at === 'number' &&
    (row.last_used_at === null || typeof row.last_used_at === 'number')
  )
}

export async function revokeCliConnection(id: string, signal?: AbortSignal): Promise<void> {
  const res = await authenticatedBffFetch(
    bffUrl(`/api/me/cli-connections/${encodeURIComponent(id)}`),
    { method: 'DELETE', signal },
  )
  if (!res.ok) throw await parseError(res)
}

/**
 * 所有受保护 BFF 调用统一带 cookie。运行中收到 401 时先静默刷新再重试一次。
 * 只有刷新明确失败才通知 AuthGate。并发刷新合并成一次；多个标签页用 navigator.locks 排队。
 *
 * 只有「本来登着」才算会话失效：未登录访客也能进工作台，他们的 401 是正常的权限边界，
 * 由动作自己在发请求前调 requireAccount() 弹登录框，这里再喊一次只会冒出第二个弹窗。
 */
export type SessionRefreshResult = 'ok' | 'raced' | 'unauthorized' | 'failed'

const SESSION_REFRESH_LOCK = 'muvloom-web-session-refresh'
let sessionRefreshInFlight: Promise<SessionRefreshResult> | null = null

async function postSessionRefresh(): Promise<SessionRefreshResult | 'superseded'> {
  const scope = bffBaseUrl()
  try {
    const attempt = await acquireRefreshAttempt(scope)
    const send = (key: SessionRefreshRequestKey) =>
      fetch(`${scope}/api/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { accept: 'application/json', [SESSION_REFRESH_REQUEST_HEADER]: key },
        signal: AbortSignal.timeout(15_000),
      })
    let key = attempt.requestKey
    let response = await send(key)
    if (response.status === 409) {
      const body: unknown = await response.clone().json()
      if (typeof body === 'object' && body !== null && 'error' in body && body.error === 'refresh_request_completed') {
        await completeRefreshAttempt(scope, attempt.requestKey)
        return 'superseded'
      }
    }
    if ((response.status === 401 || response.status === 409) && attempt.previousKey) {
      key = attempt.previousKey
      const recovered = await send(key)
      if (recovered.status !== 401 || response.status !== 409) response = recovered
    }
    if (bffBaseUrl() !== scope) return 'failed'
    if (response.ok) {
      const body: unknown = await response.json()
      if (typeof body !== 'object' || body === null || !('ok' in body) || body.ok !== true)
        return 'failed'
      const expiry =
        'access_expires_at' in body && typeof body.access_expires_at === 'number'
          ? body.access_expires_at
          : null
      // If a completed operation repaired a late Cookie, complete the current pending slot too.
      await completeRefreshAttempt(scope, attempt.requestKey, key)
      if (bffBaseUrl() !== scope) return 'failed'
      accessExpiresAt = expiry
      writeSessionRotatedAt(Date.now())
      return 'ok'
    }
    if (response.status === 409) return 'raced'
    if (response.status === 401) return 'unauthorized'
    return 'failed'
  } catch {
    // Keep the committed request key across reloads, including a lost JSON response body.
    return 'failed'
  }
}

async function restoreAndRefreshSession(): Promise<SessionRefreshResult> {
  let result = await postSessionRefresh()
  // The backend authenticated the current Cookie but this key belongs to a completed operation.
  // Persist a fresh operation identity before attempting another rotation.
  if (result === 'superseded') result = await postSessionRefresh()
  if (result === 'ok' && accessExpiresAt !== null && accessExpiresAt <= Date.now())
    result = await postSessionRefresh()
  return result === 'superseded' ? 'failed' : result
}

/** 同一标签页共享一次刷新；锁跨标签页，避免并发轮换被当成重用。 */
export function refreshWebSession(): Promise<SessionRefreshResult> {
  if (sessionRefreshInFlight) return sessionRefreshInFlight
  const run = (async () => {
    const locks = globalThis.navigator?.locks
    if (!locks?.request) return restoreAndRefreshSession()
    try {
      return await locks.request(SESSION_REFRESH_LOCK, restoreAndRefreshSession)
    } catch {
      return restoreAndRefreshSession()
    }
  })()
  sessionRefreshInFlight = run
  void run.finally(() => {
    if (sessionRefreshInFlight === run) sessionRefreshInFlight = null
  })
  return run
}

function announceSessionExpired(): void {
  window.dispatchEvent(new Event(AUTH_SESSION_EXPIRED_EVENT))
}
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
  if (userId === null) {
    accessExpiresAt = null
    writeSessionRotatedAt(null)
  }
  // The hint is presentation-only: the server session remains the sole authority.
  // Both storage and cookies are best effort so privacy mode cannot create a redirect loop.
  rememberStorageUser(userId)
  if (typeof document === 'undefined') return
  const secure = globalThis.location?.protocol === 'https:' ? '; Secure' : ''
  try {
    document.cookie =
      userId === null
        ? `${USER_SESSION_HINT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure}`
        : `${USER_SESSION_HINT_COOKIE}=1; Path=/; Max-Age=${PAGE_HINT_MAX_AGE_SECONDS}; SameSite=Lax${secure}`
  } catch {
    // Cookie access can be blocked by browser policy; the auth bootstrap still works.
  }
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
  try {
    if (typeof document !== 'undefined') {
      const hinted = document.cookie.split(';').some((part) => {
        const [name, value] = part.trim().split('=')
        return name === USER_SESSION_HINT_COOKIE && Boolean(value)
      })
      if (hinted) return true
    }
  } catch {
    // A blocked cookie jar must not hide a usable local-storage hint.
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
  const canRefresh =
    res.status === 401 &&
    isSignedIn() &&
    isClientCapabilityEnabled('accounts:login') &&
    typeof window !== 'undefined' &&
    !init.signal?.aborted &&
    requestPath(input) !== '/api/auth/refresh'
  if (!canRefresh) return res
  const outcome = await refreshWebSession()
  if ((outcome === 'ok' || outcome === 'raced') && !init.signal?.aborted) {
    const retried = await fetch(input, { ...init, credentials: 'include' })
    if (retried.status !== 401) return retried
    // 409 不签发新令牌。胜者的 Set-Cookie 可能晚一步才进 jar，再刷新一次再决定要不要登出。
    if (outcome === 'raced') {
      const again = await refreshWebSession()
      if ((again === 'ok' || again === 'raced') && !init.signal?.aborted) {
        const second = await fetch(input, { ...init, credentials: 'include' })
        if (second.status === 401) announceSessionExpired()
        return second
      }
    }
    announceSessionExpired()
    return retried
  }
  if (outcome === 'unauthorized') announceSessionExpired()
  return res
}
