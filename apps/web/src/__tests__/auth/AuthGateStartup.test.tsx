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
