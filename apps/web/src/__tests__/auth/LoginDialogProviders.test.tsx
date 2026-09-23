// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LoginDialog } from '../../auth/LoginDialog'
import { _setRuntimeConfigForTesting } from '../../lib/runtimeConfig'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

/** 弹框 portal 到 body，断言一律从 document 找，不看 host 子树。 */
function providerButtons(): HTMLButtonElement[] {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>('.auth-providers button'))
}

function dialogText(): string {
  return document.body.querySelector('.auth-dialog')?.textContent ?? ''
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
    root.render(<LoginDialog onClose={() => {}} />)
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

describe('LoginDialog third-party providers', () => {
  it('renders one button per enabled provider above the email form', async () => {
    stubProviders({ providers: [{ id: 'google', label: 'Google' }] })
    await render()

    expect(providerButtons().map((button) => button.textContent)).toEqual(['GGoogle'])
    expect(dialogText()).toContain('或使用邮箱登录')
  })

  it('hides the whole block when the deployment enables no provider', async () => {
    stubProviders({ providers: [] })
    await render()

    expect(document.body.querySelector('.auth-providers')).toBeNull()
    expect(dialogText()).not.toContain('或使用邮箱登录')
    expect(document.body.querySelector('input[name="username"]')).not.toBeNull()
  })

  it('gives an id this bundle predates a mark drawn from its label', async () => {
    stubProviders({ providers: [{ id: 'later', label: 'Later' }] })
    await render()

    expect(providerButtons().map((button) => button.textContent)).toEqual(['LLater'])
  })

  it('shows a callback failure once and clears it from the address bar', async () => {
    stubProviders({ providers: [{ id: 'google', label: 'Google' }] })
    window.history.replaceState(null, '', '/?auth_error=registration_closed&keep=1')
    await render()

    expect(dialogText()).toContain('注册暂未开放')
    expect(window.location.search).toBe('?keep=1')
  })

  it('closes when the visitor dismisses it', async () => {
    stubProviders({ providers: [] })
    const onClose = vi.fn()
    await act(async () => {
      root.render(<LoginDialog onClose={onClose} />)
    })

    const close = document.body.querySelector<HTMLButtonElement>('.auth-dialog-close')
    act(() => close?.click())

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
