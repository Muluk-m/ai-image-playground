// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb'
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { allCapabilitiesOff } from '../fixtures/capabilities'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  sessionStorage.clear()
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      switch (new URL(input, 'https://bff.example.com').pathname) {
        case '/runtime-config.json':
          return Response.json({ bff: { enabled: true, baseUrl: 'https://bff.example.com' } })
        case '/api/capabilities':
          return Response.json({ ...allCapabilitiesOff(), 'accounts:login': true })
        case '/api/auth/me':
          return Response.json({ user: { id: 'alice', username: 'alice', status: 'active' } })
        case '/api/channels':
          return Response.json({ channels: [] })
        default:
          throw new Error(`unexpected startup request: ${input}`)
      }
    }),
  )
  // Keep AuthGate and its entire eager import graph real. Only replace the lazy workspace's
  // unrelated rendering; its actual store must hydrate at the same post-authentication seam.
  vi.doMock('../../App', async () => {
    const { useStore } = await import('../../store')
    return {
      default: function Workspace() {
        const dismissed = useStore((s) => s.libraryCoachDismissed)
        return <main data-testid="workspace" data-coach-dismissed={String(dismissed)} />
      },
    }
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.doUnmock('../../App')
  vi.unstubAllGlobals()
})

function saveCoachState(key: string, dismissed: boolean) {
  localStorage.setItem(
    key,
    JSON.stringify({
      version: 1,
      state: {
        inspirationCoachDismissed: true,
        libraryCoachDismissed: dismissed,
        libraryPanelOpened: false,
      },
    }),
  )
}

async function boot() {
  // Match main.tsx: static AuthGate imports precede capability discovery and identity lookup.
  const { AuthGate } = await import('../../auth/AuthGate')
  const { loadRuntimeConfig } = await import('../../lib/runtimeConfig')
  const { bootstrapClientCapabilities } = await import('../../lib/clientCapabilities')
  await loadRuntimeConfig()
  await bootstrapClientCapabilities(true, 'https://bff.example.com')
  await act(async () =>
    root.render(
      <StrictMode>
        <AuthGate />
      </StrictMode>,
    ),
  )
  await act(async () => vi.dynamicImportSettled())
  expect(host.querySelector('[data-testid="workspace"]')).not.toBeNull()
}

function coachDismissed(): string | null | undefined {
  return host.querySelector('[data-testid="workspace"]')?.getAttribute('data-coach-dismissed')
}

describe('authenticated startup coach state', () => {
  it('keeps a returning user’s coach dismissed instead of reading anonymous defaults', async () => {
    saveCoachState('image-playground', false)
    saveCoachState('image-playground:user-alice', true)

    await boot()

    expect(coachDismissed()).toBe('true')
  })

  it('does not inherit an anonymous visitor’s dismissal for a user who has not seen the coach', async () => {
    saveCoachState('image-playground', true)
    saveCoachState('image-playground:user-alice', false)

    await boot()

    expect(coachDismissed()).toBe('false')
  })
})

describe('fallback startup', () => {
  it('opens the existing user workspace without requesting login or adoption', async () => {
    saveCoachState('image-playground', false)
    saveCoachState('image-playground:user-alice', true)
    const fetchMock = vi.mocked(fetch)
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('/api/capabilities'))
        return Response.json({ ...allCapabilitiesOff(), 'accounts:local-recovery': true })
      return original(...args)
    })
    await boot()
    expect(coachDismissed()).toBe('true')
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/auth/'))).toBe(false)
    const { scopedStorageName } = await import('../../lib/authScope')
    expect(scopedStorageName('image-playground')).toBe('image-playground:user-alice')
    const { AUTH_SESSION_EXPIRED_EVENT } = await import('../../lib/authClient')
    await act(async () => window.dispatchEvent(new Event(AUTH_SESSION_EXPIRED_EVENT)))
    expect(host.querySelector('[data-testid="workspace"]')).not.toBeNull()
  })
})

describe('anonymous startup', () => {
  /** 401 的 /api/auth/me 不再是拦路虎：访客照样进工作台，channel 清单也照拉。 */
  async function bootAnonymously(): Promise<void> {
    const fetchMock = vi.mocked(fetch)
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('/api/auth/me'))
        return Response.json({ error: 'unauthorized' }, { status: 401 })
      return original(...args)
    })
    await boot()
  }

  it('mounts the workspace for a visitor without a session', async () => {
    await bootAnonymously()

    const calls = vi.mocked(fetch).mock.calls
    expect(calls.some(([url]) => String(url).includes('/api/channels'))).toBe(true)
    const { scopedStorageName } = await import('../../lib/authScope')
    expect(scopedStorageName('image-playground')).toBe('image-playground')
    expect(document.body.querySelector('.auth-dialog')).toBeNull()
  })

  it('opens the login dialog when a gated action asks for an account', async () => {
    await bootAnonymously()
    const { requireAccount } = await import('../../auth/loginPrompt')

    let allowed = true
    await act(async () => {
      allowed = requireAccount()
    })

    expect(allowed).toBe(false)
    expect(document.body.querySelector('.auth-dialog')).not.toBeNull()
    expect(host.querySelector('[data-testid="workspace"]')).not.toBeNull()
  })

  it('closing the login dialog cancels the interrupted send', async () => {
    await bootAnonymously()
    const { queuePendingSubmission, hasPendingSubmission } = await import(
      '../../auth/pendingSubmission'
    )
    const { requireAccount } = await import('../../auth/loginPrompt')
    await queuePendingSubmission({
      kind: 'heroCanvas',
      draft: { prompt: 'a blue lantern', references: [] },
    })
    await act(async () => {
      requireAccount()
    })
    expect(document.body.querySelector('.auth-dialog')).not.toBeNull()
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('.auth-dialog-close')?.click()
    })
    await vi.waitFor(async () => expect(await hasPendingSubmission()).toBe(false))
    expect(document.body.querySelector('.auth-dialog')).toBeNull()
  })

  it('keeps the workspace up and offers a re-login when the session expires', async () => {
    await boot()
    const { AUTH_SESSION_EXPIRED_EVENT } = await import('../../lib/authClient')

    await act(async () => window.dispatchEvent(new Event(AUTH_SESSION_EXPIRED_EVENT)))

    expect(host.querySelector('[data-testid="workspace"]')).not.toBeNull()
    const card = host.textContent ?? ''
    expect(card).toContain('登录状态已失效')

    const relogin = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === '重新登录',
    )
    await act(async () => relogin?.click())

    expect(document.body.querySelector('.auth-dialog')).not.toBeNull()
  })
})
