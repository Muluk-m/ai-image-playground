/** 登录会话 cookie 的名字。BFF 设置它，跑图脚本这类不连数据库的调用方也按它带会话。 */
export const USER_SESSION_COOKIE = 'image_playground_session'
/** 非 HttpOnly、不含凭据。前端用它判断要不要请求 /api/auth/me，避免匿名访客打出 401。 */
export const USER_SESSION_HINT_COOKIE = 'image_playground_signed_in'

export const USERNAME_MIN_LENGTH = 3
export const USERNAME_MAX_LENGTH = 32
export const EMAIL_MAX_LENGTH = 254
export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = 128
export const ADMIN_USER_NOTE_MAX_LENGTH = 500

/** 未上传头像时，账户设置与 /api/auth/me 都返回这张芽标。路径相对前端站点，不相对 API。 */
export const DEFAULT_AVATAR_PATH = '/brand/avatar-artist-192.png'

export const NICKNAME_MIN_LENGTH = 2
export const NICKNAME_MAX_LENGTH = 20
export const BIO_MAX_LENGTH = 120
/** 头像上传的原始字节上限。服务端会再压成 512×512 WebP。 */
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024
export const AVATAR_EDGE_PX = 512

/**
 * 昵称里不许出现的子串，用来挡住冒充官方的名字。比较前会去掉所有空白，
 * 「客 服」和「客服」一样被拒。
 */
export const NICKNAME_BLOCKED_SUBSTRINGS = ['官方', '客服'] as const

export type NicknameErrorCode = 'nickname_invalid' | 'nickname_blocked'
export type BioErrorCode = 'bio_invalid'

const USERNAME_PATTERN = /^[a-z0-9._-]+$/
const EMAIL_PATTERN =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

export interface AuthUserView {
  id: string
  username: string
  /**
   * 以下四项 /api/auth/me、登录和注册都会带上。类型保持可选，是为了旧的
   * `{ id, username }` 赋值还能通过；新的调用方应当读取它们。
   */
  nickname?: string | null
  bio?: string | null
  /**
   * 自定义头像是 API 路径 `/api/avatars/:userId?v=`，默认头像是
   * {@link DEFAULT_AVATAR_PATH}（前端源）。用 `avatar_is_default` 决定相对哪一个源。
   */
  avatar_url?: string
  avatar_is_default?: boolean
}

/** GET/PATCH `/api/me/profile` 与头像上传的响应。字段始终在。 */
export interface AccountProfileView {
  readonly id: string
  readonly username: string
  readonly nickname: string | null
  readonly bio: string | null
  readonly avatar_url: string
  readonly avatar_is_default: boolean
}

/** GET `/api/me/sessions` 里的一条登录设备。不含会话令牌。 */
export interface AccountSessionView {
  readonly current: boolean
  readonly user_agent: string | null
  readonly device_label: string
  readonly ip: string | null
  readonly created_at: number
  readonly last_active_at: number
}

export interface LoginIdentityView {
  readonly provider: string
  readonly email: string | null
  readonly linked_at: number
}

/** Every way the signed-in account can authenticate; drives the account panel. */
export interface LoginMethodsView {
  readonly password: boolean
  readonly identities: readonly LoginIdentityView[]
}

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase()
}

export function isValidEmailAddress(value: string): boolean {
  const email = normalizeUsername(value)
  return email.length <= EMAIL_MAX_LENGTH && email.indexOf('@') <= 64 && EMAIL_PATTERN.test(email)
}

export function isValidUsername(value: string): boolean {
  const username = normalizeUsername(value)
  if (username.length < USERNAME_MIN_LENGTH) return false
  return (
    (username.length <= USERNAME_MAX_LENGTH && USERNAME_PATTERN.test(username)) ||
    isValidEmailAddress(username)
  )
}

export function isValidPassword(value: string): boolean {
  return value.length >= PASSWORD_MIN_LENGTH && value.length <= PASSWORD_MAX_LENGTH
}

/** 按 Unicode 码位计数，和 PostgreSQL 的 `char_length` 对齐。 */
export function profileTextLength(value: string): number {
  return Array.from(value).length
}

function hasControlCharacter(value: string): boolean {
  return /[\u0000-\u001F\u007F]/.test(value)
}

/** 去掉全部空白后再查冒充用词，避免用空格把「官方」拆开。 */
export function nicknameError(value: string): NicknameErrorCode | null {
  const nickname = value.trim()
  const length = profileTextLength(nickname)
  if (
    length < NICKNAME_MIN_LENGTH ||
    length > NICKNAME_MAX_LENGTH ||
    hasControlCharacter(nickname)
  ) {
    return 'nickname_invalid'
  }
  const compact = nickname.replace(/\s+/g, '')
  if (NICKNAME_BLOCKED_SUBSTRINGS.some((word) => compact.includes(word))) {
    return 'nickname_blocked'
  }
  return null
}

/**
 * 空串表示清空简介。有内容时去掉首尾空白，最长 {@link BIO_MAX_LENGTH} 个码位，
 * 不能含控制字符（含换行）。
 */
export function bioError(value: string): BioErrorCode | null {
  if (value.trim() === '') return null
  const bio = value.trim()
  if (profileTextLength(bio) > BIO_MAX_LENGTH || hasControlCharacter(bio)) return 'bio_invalid'
  return null
}
