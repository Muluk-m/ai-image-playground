import { isGuestLoginPromptPath } from '../lib/appPaths'
import { isClientCapabilityEnabled } from '../lib/clientCapabilities'

/**
 * 登录提示的唯一接缝。未登录访客照常进工作台。进入工作台地址且会话已判定为未登录时，
 * AuthGate 会自动打开登录框；关掉之后同一次浏览器会话不再自动弹出。顶栏登录按钮和
 * 需要账号的动作仍走这里，不受这次关闭影响。
 *
 * 刻意不依赖 React 与 store：调用方一半是模块级函数（store.ts 的提交、agentClient 的
 * 发送、toolFailure 的失败动作），它们拿不到 context，也不能在 store 求值之前 import store。
 */
export type LoginPromptReason = 'gated-action' | 'session-expired'

const LOGIN_PROMPT_EVENT = 'image-playground:login-prompt'

let signedIn = false

/** 由 AuthGate 在解析完 /api/auth/me 与每次会话失效时写入。 */
export function setSignedIn(value: boolean): void {
  signedIn = value
}

export function isSignedIn(): boolean {
  return signedIn
}

/** 这个部署有账号体系，而当前访客还没登录。 */
export function accountRequired(): boolean {
  return isClientCapabilityEnabled('accounts:login') && !signedIn
}

export function promptLogin(reason: LoginPromptReason = 'gated-action'): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(LOGIN_PROMPT_EVENT, { detail: reason }))
}

/**
 * 需要账号的动作统一从这里过：能做返回 true；不能做就弹登录框并返回 false。
 * 没开 `accounts:login` 的部署一律放行——那里根本没有账号这个概念。
 */
export function requireAccount(): boolean {
  if (!accountRequired()) return true
  promptLogin('gated-action')
  return false
}

export function subscribeLoginPrompt(listener: (reason: LoginPromptReason) => void): () => void {
  const handle = (event: Event) => {
    const detail = (event as CustomEvent<LoginPromptReason>).detail
    listener(detail === 'session-expired' ? 'session-expired' : 'gated-action')
  }
  window.addEventListener(LOGIN_PROMPT_EVENT, handle)
  return () => window.removeEventListener(LOGIN_PROMPT_EVENT, handle)
}

const GUEST_LOGIN_PROMPT_DISMISSED_KEY = 'aip.guest-login-prompt-dismissed'

/** 与官网语言跳转相同：爬虫不自动弹框，避免它们只抓到遮罩。 */
const BOT_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit/i

/** sessionStorage 写不进去时，仍保证这一次页面生命周期内不再自动弹出。 */
let guestLoginPromptDismissed = false

function guestLoginPromptStorage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null
    return window.sessionStorage
  } catch {
    return null
  }
}

export function guestLoginPromptDismissedThisSession(): boolean {
  if (guestLoginPromptDismissed) return true
  try {
    const storage = guestLoginPromptStorage()
    if (storage?.getItem(GUEST_LOGIN_PROMPT_DISMISSED_KEY) === '1') {
      guestLoginPromptDismissed = true
      return true
    }
    return false
  } catch {
    return false
  }
}

export function rememberGuestLoginPromptDismissed(): void {
  guestLoginPromptDismissed = true
  try {
    guestLoginPromptStorage()?.setItem(GUEST_LOGIN_PROMPT_DISMISSED_KEY, '1')
  } catch {
    // 内存标记已经记下，刷新后可能会再自动弹一次。
  }
}

export function isAutomationUserAgent(
  userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent,
): boolean {
  return BOT_UA.test(userAgent)
}

/** 会话已判定为未登录、当前是工作台地址、且本会话还没关过自动弹出的登录框。 */
export function shouldAutoOpenGuestLoginPrompt(pathname: string): boolean {
  if (typeof window === 'undefined') return false
  if (!accountRequired()) return false
  if (guestLoginPromptDismissedThisSession()) return false
  if (isAutomationUserAgent()) return false
  return isGuestLoginPromptPath(pathname)
}
