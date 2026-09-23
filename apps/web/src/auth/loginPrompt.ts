import { isClientCapabilityEnabled } from '../lib/clientCapabilities'

/**
 * 登录提示的唯一接缝。未登录访客照常进工作台，直到他按下一件需要账号的事——那一刻
 * 由这里把登录框叫起来。
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
