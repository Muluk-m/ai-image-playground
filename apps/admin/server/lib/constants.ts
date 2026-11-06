export const SESSION_COOKIE_NAME = 'admin_session'
export const REFRESH_COOKIE_NAME = 'admin_refresh'
/** Admin access token is deliberately short lived; the refresh cookie keeps the browser signed in. */
export const ACCESS_TTL_MS = 15 * 60 * 1000
/** Signed refresh tokens slide for 30 days, with a hard 90-day chain lifetime. */
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const SESSION_ABSOLUTE_TTL_MS = 90 * 24 * 60 * 60 * 1000

// Kept as an alias for callers and tests that used the old single-cookie name.
export const SESSION_TTL_MS = ACCESS_TTL_MS
