// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LoginScreen } from '../../auth/LoginScreen'
import { oauthStartUrl } from '../../lib/authClient'
import { _setRuntimeConfigForTesting } from '../../lib/runtimeConfig'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

function providerButtons(): HTMLButtonElement[] {
  return Array.from(host.querySelectorAll<HTMLButtonElement>('.auth-providers button'))
}

/** Answers the providers endpoint and lets every other request fail closed. */
function stubProviders(body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) =>
      input.includes('/api/auth/oauth/providers')
        ? Response.json(body)
        : new Response('{}', { status: 404 }),
    ),
  )
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(<LoginScreen />)
  })
}

beforeEach(() => {
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'https://api.example.com' } })
  window.history.replaceState(null, '', '/')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

describe('LoginScreen third-party providers', () => {
  it('renders one button per enabled provider and links it to the BFF start route', async () => {
    stubProviders({ providers: [{ id: 'google', label: 'Google' }] })
    await render()

    expect(providerButtons().map((button) => button.textContent)).toEqual(['GGoogle'])
    expect(host.textContent).toContain('或使用邮箱登录')
    expect(oauthStartUrl('google')).toBe('https://api.example.com/api/auth/oauth/google/start')
  })

  it('hides the whole block when the deployment enables no provider', async () => {
    stubProviders({ providers: [] })
    await render()

    expect(host.querySelector('.auth-providers')).toBeNull()
    expect(host.textContent).not.toContain('或使用邮箱登录')
    expect(host.querySelector('input[name="username"]')).not.toBeNull()
  })

  it('drops malformed entries but still renders an id this bundle predates', async () => {
    stubProviders({ providers: [{ id: 'myspace', label: 'MySpace' }, { label: 'no id' }, 'nope'] })
    await render()

    expect(providerButtons().map((button) => button.textContent)).toEqual(['MMySpace'])
  })

  it('hides the block when the providers endpoint is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    )
    await render()

    expect(host.querySelector('.auth-providers')).toBeNull()
  })

  it('shows a callback failure once and clears it from the address bar', async () => {
    stubProviders({ providers: [{ id: 'google', label: 'Google' }] })
    window.history.replaceState(null, '', '/?auth_error=registration_closed&keep=1')
    await render()

    expect(host.textContent).toContain('注册暂未开放')
    expect(window.location.search).toBe('?keep=1')
  })
})
