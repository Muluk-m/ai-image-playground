/**
 * 本机回调登录：确认页批准后带着一次性授权码和 CLI 生成的 state 跳回本机。只认回环 IP 上的
 * `/callback`，服务端已经校验过，这里再核一次，页面不会被引去别处。
 */
const STATE = /^[A-Za-z0-9_-]{16,128}$/

export function loopbackStateFromAddress(): string | null {
  if (typeof window === 'undefined') return null
  const state = new URL(window.location.href).searchParams.get('state')
  return state && STATE.test(state) ? state : null
}

export function loopbackTarget(redirectTo: unknown, state: string): string | null {
  if (typeof redirectTo !== 'string') return null
  let url: URL
  try {
    url = new URL(redirectTo)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' || (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]'))
    return null
  if (!url.port || url.pathname !== '/callback' || !url.searchParams.get('code')) return null
  url.searchParams.set('state', state)
  return url.toString()
}

export function leaveTo(url: string): void {
  window.location.assign(url)
}
