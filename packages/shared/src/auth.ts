export const USERNAME_MIN_LENGTH = 3
export const USERNAME_MAX_LENGTH = 32
export const EMAIL_MAX_LENGTH = 254
export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = 128

const USERNAME_PATTERN = /^[a-z0-9._-]+$/
const EMAIL_PATTERN =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

export interface AuthUserView {
  id: string
  username: string
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
