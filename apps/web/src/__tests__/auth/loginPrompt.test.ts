// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('guest login prompt dismissal', () => {
  const sessionStorageDescriptor = Object.getOwnPropertyDescriptor(window, 'sessionStorage')

  beforeEach(() => {
    vi.resetModules()
    if (sessionStorageDescriptor) {
      Object.defineProperty(window, 'sessionStorage', sessionStorageDescriptor)
    }
    sessionStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (sessionStorageDescriptor) {
      Object.defineProperty(window, 'sessionStorage', sessionStorageDescriptor)
    }
  })

  it('reads and writes sessionStorage in a normal browser', async () => {
    const { guestLoginPromptDismissedThisSession, rememberGuestLoginPromptDismissed } =
      await import('../../auth/loginPrompt')
    expect(guestLoginPromptDismissedThisSession()).toBe(false)
    rememberGuestLoginPromptDismissed()
    expect(guestLoginPromptDismissedThisSession()).toBe(true)
    expect(sessionStorage.getItem('aip.guest-login-prompt-dismissed')).toBe('1')
  })

  it('keeps dismissal in memory when setItem throws', async () => {
    const { guestLoginPromptDismissedThisSession, rememberGuestLoginPromptDismissed } =
      await import('../../auth/loginPrompt')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
    })
    rememberGuestLoginPromptDismissed()
    expect(guestLoginPromptDismissedThisSession()).toBe(true)
  })

  it('keeps dismissal in memory when sessionStorage access throws', async () => {
    const { guestLoginPromptDismissedThisSession, rememberGuestLoginPromptDismissed } =
      await import('../../auth/loginPrompt')
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() {
        throw new DOMException('blocked', 'SecurityError')
      },
    })
    expect(guestLoginPromptDismissedThisSession()).toBe(false)
    rememberGuestLoginPromptDismissed()
    expect(guestLoginPromptDismissedThisSession()).toBe(true)
  })
})
