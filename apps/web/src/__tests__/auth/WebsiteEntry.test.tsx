// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AuthBoundary } from '../../../../website/src/components/AuthBoundary'
import SiteAuth from '../../../../website/src/components/SiteAuth'

const state = vi.hoisted(() => ({
  probe: false,
  user: null as { id: string } | null,
  pending: false,
  failed: false,
  login: true,
}))
vi.mock('../../lib/privateOverlay', () => ({ PrivateWebSupportsReferrals: false }))
vi.mock('../../auth/LoginDialog', () => ({
  LoginDialog: ({ onAuthenticated }: { onAuthenticated: () => void }) => (
    <button type="button" onClick={onAuthenticated}>
      Sign in
    </button>
  ),
}))
vi.mock('../../auth/pendingSubmission', () => ({
  hasPendingSubmission: async () => state.pending,
  discardPendingSubmission: vi.fn(),
}))
vi.mock('../../lib/runtimeConfig', () => ({
  loadRuntimeConfig: async () => ({ bff: { enabled: true, baseUrl: '' } }),
}))
vi.mock('../../lib/clientCapabilities', () => ({
  bootstrapClientCapabilities: async () => {
    if (state.failed) throw new Error('offline')
  },
  isClientCapabilityEnabled: () => state.login,
}))
vi.mock('../../lib/authClient', () => ({
  AuthRequestError: class extends Error {},
  getCurrentUser: async () => state.user,
  noteBrowserSession: vi.fn(),
  shouldProbeSession: () => state.probe,
}))
vi.mock('../../theme', () => ({ initTheme: vi.fn() }))
let host: HTMLDivElement, root: Root
const replace = vi.fn(),
  assign = vi.fn(),
  onOpen = vi.fn()
beforeEach(() => {
  state.probe = false
  state.user = null
  state.pending = false
  state.failed = false
  state.login = true
  replace.mockClear()
  assign.mockClear()
  onOpen.mockClear()
  vi.stubGlobal('location', { replace, assign, search: '' })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  document.title = 'Website page title'
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})
async function render(open = false, page = 'home') {
  await act(async () => {
    root.render(
      <SiteAuth locale="zh-CN" page={page} open={open} onOpen={onOpen} onClose={() => {}} />,
    )
  })
}
it('keeps an anonymous homepage visible until the visitor starts creating', async () => {
  await render()
  expect(document.body.textContent).not.toContain('Sign in')
  expect(replace).not.toHaveBeenCalled()
  await render(true)
  expect(document.body.textContent).toContain('Sign in')
  expect(document.title).toBe('Website page title')
})
it('takes a verified existing session directly to the workbench', async () => {
  state.probe = true
  state.user = { id: 'fixture' }
  await render()
  expect(replace).toHaveBeenCalledExactlyOnceWith('/image')
})
it('opens login to recover a pending workbench submission', async () => {
  state.pending = true
  await render()
  expect(onOpen).toHaveBeenCalledOnce()
  await render(true)
  expect(document.body.textContent).toContain('Sign in')
})
it('enters the workbench after login without submitting a sample prompt', async () => {
  await render(true)
  await act(async () => host.querySelector('button')!.click())
  expect(assign).toHaveBeenCalledExactlyOnceWith('/image')
})
it('keeps a network failure recoverable instead of navigating to a broken workbench', async () => {
  state.failed = true
  await render(true)
  expect(document.body.textContent).toContain('暂时无法连接')
  expect(replace).not.toHaveBeenCalled()
})

it('enters the workbench when login is disabled by the deployment', async () => {
  state.login = false
  await render()
  expect(replace).toHaveBeenCalledExactlyOnceWith('/image')
})

it('keeps a failed auth chunk recoverable without replacing the website', async () => {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  function BrokenChunk(): never {
    throw new Error('chunk unavailable')
  }
  try {
    await act(async () =>
      root.render(
        <AuthBoundary locale="zh-CN" visible={false} onClose={() => {}}>
          <BrokenChunk />
        </AuthBoundary>,
      ),
    )
    expect(host.textContent).toBe('')
    await act(async () =>
      root.render(
        <AuthBoundary locale="zh-CN" visible onClose={() => {}}>
          <BrokenChunk />
        </AuthBoundary>,
      ),
    )
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('暂时无法连接')
    expect(document.body.textContent).toContain('重试')
  } finally {
    consoleError.mockRestore()
  }
})
