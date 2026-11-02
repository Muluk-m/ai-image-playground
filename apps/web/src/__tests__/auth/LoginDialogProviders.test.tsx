// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LoginDialog } from '../../auth/LoginDialog'
import { bootstrapClientCapabilities } from '../../lib/clientCapabilities'
import { _setRuntimeConfigForTesting } from '../../lib/runtimeConfig'
import { allCapabilitiesOff } from '../fixtures/capabilities'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../lib/privateOverlay', () => ({
  PrivateWebSupportsReferrals: true,
  PrivateWebOAuthProviderMarks: {
    enterprise: () => <img src="/official-provider.png" alt="" aria-hidden="true" />,
  },
}))

let host: HTMLDivElement
let root: Root

/** 弹框 portal 到 body，断言一律从 document 找，不看 host 子树。 */
function providerButtons(): HTMLButtonElement[] {
  return Array.from(
    document.body.querySelectorAll<HTMLButtonElement>('[data-auth-providers] button'),
  )
}

function dialogText(): string {
  return document.body.querySelector('.auth-dialog')?.textContent ?? ''
}

/** Answers the providers endpoint and lets every other request fail closed. */
function stubProviders(body: {
  providers: unknown[]
  loginMethods?: { password: boolean; registration: boolean }
}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) =>
      input.includes('/api/auth/oauth/providers')
        ? Response.json({ loginMethods: { password: true, registration: true }, ...body })
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

    expect(document.body.querySelector('[data-auth-providers]')).toBeNull()
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

    const close = document.body.querySelector<HTMLButtonElement>('button[aria-label="关闭登录框"]')
    act(() => close?.click())

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

it('always shows the optional invitation input without a disclosure when enabled', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) =>
      input.includes('/api/capabilities')
        ? Response.json({
            ...allCapabilitiesOff(),
            'accounts:self-register': true,
            'billing:credits': true,
          })
        : Response.json({ providers: [], loginMethods: { password: true, registration: true } }),
    ),
  )
  await bootstrapClientCapabilities(true, 'https://api.example.com')
  await render()
  await act(async () => {
    const register = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('立即注册'),
    )
    if (!register) throw new Error('missing registration entry')
    register.click()
  })
  const invitation = document.querySelector<HTMLInputElement>('input[name="referral_code"]')
  expect(invitation).not.toBeNull()
  expect(invitation?.closest('details')).toBeNull()
  expect(invitation?.disabled).toBe(false)
  expect(invitation?.closest('label')?.textContent).toBe('邀请码（选填）')
  await bootstrapClientCapabilities(false, '')
})

it('never flashes local forms while policy loads or when discovery fails', async () => {
  let reject!: (error: Error) => void
  const promise = new Promise<Response>((_resolve, rejectPromise) => {
    reject = rejectPromise
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(() => promise),
  )
  await render()
  expect(document.querySelector('form')).toBeNull()
  expect(document.querySelector('.auth-divider')).toBeNull()
  await act(async () => reject(new Error('offline')))
  expect(document.querySelector('form')).toBeNull()
  expect(document.querySelector('[role="alert"]')).not.toBeNull()
})

it('renders only the allowed provider and private mark even with a referral', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        ...allCapabilitiesOff(),
        'accounts:self-register': true,
        'billing:credits': true,
      }),
    ),
  )
  await bootstrapClientCapabilities(true, 'https://api.example.com')
  window.history.replaceState(null, '', '/?ref=invite&auth_error=access_denied')
  stubProviders({
    providers: [{ id: 'enterprise', label: 'Enterprise' }],
    loginMethods: { password: false, registration: false },
  })
  await render()
  expect(providerButtons().map((button) => button.textContent)).toEqual(['Enterprise'])
  expect(providerButtons()[0]?.querySelector('img')?.getAttribute('src')).toBe(
    '/official-provider.png',
  )
  expect(document.querySelector('form')).toBeNull()
  expect(document.querySelector('input')).toBeNull()
  expect(document.querySelector('.auth-divider')).toBeNull()
  expect(dialogText()).not.toContain('立即注册')
  expect(dialogText()).not.toContain('Google')
  expect(document.querySelector('[role="alert"]')).not.toBeNull()
  expect(vi.mocked(fetch).mock.calls[0]?.[0]).toContain('frontend_origin=')
  await bootstrapClientCapabilities(false, '')
})
