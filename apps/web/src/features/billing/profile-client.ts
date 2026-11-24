import { authenticatedBffFetch, bffBaseUrl } from '../../lib/privateHost'

/**
 * 账户设置的薄客户端，对齐公开仓 PR #1272。
 *
 *   GET/PATCH /api/me/profile
 *     { id, username, nickname, bio, avatar_url, avatar_is_default }
 *     PATCH 只接受 { nickname?, bio? }
 *     错误：nickname_invalid（2–20 字）、nickname_blocked（官方/客服）、bio_invalid（≤120，无换行）
 *   POST /api/me/avatar          multipart 字段 file，返回同一份资料
 *     错误：avatar_type、avatar_too_large (413)、avatar_invalid (422)、rate_limited (429)
 *   GET  /api/me/sessions        { sessions: [{ current, user_agent, device_label, ip, created_at, last_active_at }] }
 *   POST /api/me/sessions/revoke-others   { revoked }
 *   DELETE /api/me               { password? }，成功后服务端清掉会话 cookie
 *     错误：current_password_required、invalid_credentials、account_delete_blocked (409)
 *   GET /api/auth/me             user 带同样的资料字段。profile 还没部署（404）时退回这一份。
 *
 * 默认头像是前端源 `/brand/avatar-artist-192.png`。自定义头像是 `/api/avatars/<id>?v=`，相对 BFF。
 *
 * 登录方式沿用现成接口：
 *   GET    /api/auth/login-methods
 *   POST   /api/auth/password
 *   DELETE /api/auth/oauth/google/link     409 last_login_method，404 not_linked
 */

export const profilePaths = {
  profile: '/api/me/profile',
  avatar: '/api/me/avatar',
  sessions: '/api/me/sessions',
  revokeOthers: '/api/me/sessions/revoke-others',
  deleteAccount: '/api/me',
  authMe: '/api/auth/me',
  loginMethods: '/api/auth/login-methods',
  password: '/api/auth/password',
  oauthLink: (provider: string) => `/api/auth/oauth/${encodeURIComponent(provider)}/link`,
} as const

export const AVATAR_FILE_FIELD = 'file'
/** 未上传时接口返回的芽标。路径相对前端站点，不相对 API。 */
export const DEFAULT_AVATAR_PATH = '/brand/avatar-artist-192.png'
export const NICKNAME_MIN_LENGTH = 2
export const NICKNAME_MAX_LENGTH = 20
export const BIO_MAX_LENGTH = 120
export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = 128

const NICKNAME_BLOCKED = ['官方', '客服'] as const

export class ProfileRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code)
    this.name = 'ProfileRequestError'
  }
}

export interface AccountProfile {
  userId: string
  username: string
  nickname: string | null
  bio: string | null
  /** 自定义头像的绝对或同源地址。默认芽标为 null，由 AccountAvatar 画前端静态图。 */
  avatarUrl: string | null
  avatarIsDefault: boolean
}

export interface LoginMethods {
  password: boolean
  google: { linked: boolean; email: string | null }
  linkedCount?: number
}

export interface LoginSession {
  current: boolean
  deviceLabel: string
  userAgent: string | null
  ip: string | null
}

export type NicknameIssue = 'empty' | 'invalid' | 'blocked'

function textLength(value: string): number {
  return [...value].length
}

function hasControlCharacter(value: string): boolean {
  return /[\u0000-\u001F\u007F]/.test(value)
}

/** 与服务端 nicknameError 同一套：2–20 个码位，去掉全部空白后仍不许含「官方」「客服」。 */
export function nicknameIssue(value: string): NicknameIssue | null {
  const nickname = value.trim()
  if (!nickname) return 'empty'
  if (
    textLength(nickname) < NICKNAME_MIN_LENGTH ||
    textLength(nickname) > NICKNAME_MAX_LENGTH ||
    hasControlCharacter(nickname)
  ) {
    return 'invalid'
  }
  const compact = nickname.replace(/\s+/g, '')
  if (NICKNAME_BLOCKED.some((word) => compact.includes(word))) return 'blocked'
  return null
}

/** 空串表示清空。有内容时最长 120 个码位，不能含换行等控制字符。 */
export function bioIssue(value: string): 'invalid' | null {
  if (value.trim() === '') return null
  const bio = value.trim()
  if (textLength(bio) > BIO_MAX_LENGTH || hasControlCharacter(bio)) return 'invalid'
  return null
}

type JsonRecord = Record<string, unknown>

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as JsonRecord
}

function stringField(record: JsonRecord | null, ...keys: string[]): string | null {
  if (!record) return null
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function profileSource(body: unknown): JsonRecord | null {
  const root = asRecord(body)
  return asRecord(root?.profile) ?? asRecord(root?.user) ?? root
}

function isDefaultAvatar(url: string | null, source: JsonRecord | null): boolean {
  if (source?.avatar_is_default === true || source?.avatarIsDefault === true) return true
  if (source?.avatar_is_default === false || source?.avatarIsDefault === false) return false
  return !url || url === DEFAULT_AVATAR_PATH || url.startsWith('/brand/')
}

/** 芽标留在前端源；`/api/avatars/...` 相对 BFF。blob/data/绝对地址原样返回。 */
export function resolveAvatarUrl(url: string | null, isDefault: boolean): string | null {
  if (!url || isDefault || url === DEFAULT_AVATAR_PATH || url.startsWith('/brand/')) return null
  if (/^(https?:|blob:|data:)/.test(url)) return url
  if (url.startsWith('/')) return `${bffBaseUrl()}${url}`
  return url
}

export function parseProfile(body: unknown): AccountProfile {
  const source = profileSource(body)
  const rawAvatar = stringField(source, 'avatar_url', 'avatarUrl')
  const avatarIsDefault = isDefaultAvatar(rawAvatar, source)
  return {
    userId: stringField(source, 'id', 'user_id', 'userId') ?? '',
    username: stringField(source, 'username') ?? '',
    nickname: stringField(source, 'nickname'),
    bio: stringField(source, 'bio'),
    avatarUrl: resolveAvatarUrl(rawAvatar, avatarIsDefault),
    avatarIsDefault,
  }
}

export function parseLoginMethods(body: unknown): LoginMethods {
  const root = asRecord(body)
  const identities = Array.isArray(root?.identities) ? root.identities : []
  const records = identities.map((item) => asRecord(item)).filter((item) => item !== null)
  const google = records.find((item) => item.provider === 'google')
  return {
    password: root?.password === true,
    google: {
      linked: Boolean(google),
      email: typeof google?.email === 'string' ? google.email : null,
    },
    linkedCount: records.length,
  }
}

function sessionLabel(row: JsonRecord): string {
  const label = stringField(row, 'device_label', 'deviceLabel')
  if (label) return label
  const client = stringField(row, 'client', 'browser')
  const os = stringField(row, 'os', 'platform')
  if (client && os) return `${client} · ${os}`
  return client || os || ''
}

export function parseSessions(body: unknown): LoginSession[] {
  const root = asRecord(body)
  const list = Array.isArray(root?.sessions) ? root.sessions : Array.isArray(body) ? body : []
  return list.flatMap((item) => {
    const row = asRecord(item)
    if (!row) return []
    return [
      {
        current: row.current === true,
        deviceLabel: sessionLabel(row),
        userAgent: stringField(row, 'user_agent', 'userAgent'),
        ip: stringField(row, 'ip'),
      },
    ]
  })
}

export function describeSessions(sessions: LoginSession[]): {
  label: string
  others: number
} | null {
  if (sessions.length === 0) return null
  const current = sessions.find((session) => session.current) ?? sessions[0]
  if (!current) return null
  return {
    label: current.deviceLabel,
    others: sessions.filter((session) => session !== current).length,
  }
}

function endpoint(path: string): string {
  return `${bffBaseUrl()}${path}`
}

async function send(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await authenticatedBffFetch(endpoint(path), {
    ...init,
    headers: { accept: 'application/json', ...init.headers },
  })
  const text = await response.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text) as unknown
    } catch {
      body = null
    }
  }
  if (!response.ok) {
    const record = asRecord(body)
    const code = typeof record?.error === 'string' ? record.error : `http_${response.status}`
    throw new ProfileRequestError(response.status, code)
  }
  return body
}

export async function fetchProfile(): Promise<AccountProfile> {
  try {
    return parseProfile(await send(profilePaths.profile))
  } catch (error) {
    if (!(error instanceof ProfileRequestError) || error.status !== 404) throw error
  }
  return parseProfile(await send(profilePaths.authMe))
}

export async function updateProfile(patch: {
  nickname?: string
  bio?: string | null
}): Promise<AccountProfile> {
  return parseProfile(
    await send(profilePaths.profile, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  )
}

export async function uploadAvatar(file: Blob): Promise<AccountProfile> {
  const body = new FormData()
  const name =
    file.type === 'image/jpeg'
      ? 'avatar.jpg'
      : file.type === 'image/webp'
        ? 'avatar.webp'
        : 'avatar.png'
  body.set(AVATAR_FILE_FIELD, file, name)
  return parseProfile(await send(profilePaths.avatar, { method: 'POST', body }))
}

export async function fetchLoginMethods(): Promise<LoginMethods> {
  return parseLoginMethods(await send(profilePaths.loginMethods))
}

export async function updatePassword(input: {
  currentPassword?: string
  newPassword: string
}): Promise<void> {
  await send(profilePaths.password, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...(input.currentPassword ? { current_password: input.currentPassword } : {}),
      new_password: input.newPassword,
    }),
  })
}

export function googleLinkUrl(): string {
  return endpoint(profilePaths.oauthLink('google'))
}

export async function unlinkGoogle(): Promise<void> {
  await send(profilePaths.oauthLink('google'), { method: 'DELETE' })
}

export async function fetchSessions(): Promise<LoginSession[]> {
  return parseSessions(await send(profilePaths.sessions))
}

export async function revokeOtherSessions(): Promise<number> {
  const body = asRecord(
    await send(profilePaths.revokeOthers, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  )
  return typeof body?.revoked === 'number' ? body.revoked : 0
}

export async function deleteAccount(password?: string): Promise<void> {
  await send(profilePaths.deleteAccount, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(password ? { password } : {}),
  })
}
