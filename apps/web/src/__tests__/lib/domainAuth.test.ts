import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { restoreLogin } from '../../lib/localCompatibility/auth'

const config = { sourceOrigin: 'https://old.example', targetOrigin: 'https://new.example' }
let data: Map<string, string>
const replace = vi.fn()
beforeEach(() => {
  data = new Map()
  replace.mockClear()
  vi.stubGlobal('location', {
    origin: config.targetOrigin,
    href: `${config.targetOrigin}/p/short?x=1#canvas`,
    replace,
  })
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => data.set(k, v),
  })
  vi.stubGlobal('history', { state: null, replaceState: vi.fn() })
})
afterEach(() => vi.unstubAllGlobals())
it('hands off only once and never signs a user back in after logout', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ user: { id: 'existing' } }))
  expect(await restoreLogin(config, 'https://api.new.example', fetcher)).toBe(true)
  expect(await restoreLogin(config, 'https://api.new.example', fetcher)).toBe(true)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(replace).not.toHaveBeenCalled()
})
it('uses a top-level handoff only after the target API confirms availability', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 401 }))
    .mockResolvedValueOnce(Response.json({ enabled: true }))
  expect(await restoreLogin(config, 'https://api.new.example', fetcher)).toBe(false)
  const url = new URL(replace.mock.calls[0]![0])
  expect(url.origin).toBe('https://api.new.example')
  expect(url.searchParams.get('return')).toBe('/p/short?x=1#canvas')
})
it('mounts the app when the API cannot answer, instead of returning to the old workbench', async () => {
  const fetcher = vi.fn().mockRejectedValue(new Error('offline'))
  expect(await restoreLogin(config, 'https://api.new.example', fetcher)).toBe(true)
  expect(replace).not.toHaveBeenCalled()
})
it('mounts the app when the deployment has no login at all', async () => {
  // `accounts:login` 关着时 /api/auth/me 答 404，不是 401。
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 404 }))
  expect(await restoreLogin(config, 'https://api.new.example', fetcher)).toBe(true)
  expect(replace).not.toHaveBeenCalled()
})
it('mounts the app when the handoff is switched off', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 401 }))
    .mockResolvedValueOnce(Response.json({ enabled: false }))
  expect(await restoreLogin(config, 'https://api.new.example', fetcher)).toBe(true)
  expect(replace).not.toHaveBeenCalled()
})
it('removes callback parameters before mounting the app', async () => {
  vi.stubGlobal('location', {
    origin: config.targetOrigin,
    href: `${config.targetOrigin}/p/short?__domain_auth=done&x=1#canvas`,
    replace,
  })
  expect(
    await restoreLogin(
      config,
      'https://api.new.example',
      vi.fn().mockResolvedValue(Response.json({ completed: true })),
    ),
  ).toBe(true)
  expect(history.replaceState).toHaveBeenCalledWith(null, '', '/p/short?x=1#canvas')
})

it('does not trust a forged completion query', async () => {
  vi.stubGlobal('location', {
    origin: config.targetOrigin,
    href: `${config.targetOrigin}/p/short?__domain_auth=done`,
    replace,
  })
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ completed: false }))
    .mockResolvedValueOnce(new Response(null, { status: 401 }))
    .mockResolvedValueOnce(Response.json({ enabled: true }))
  expect(await restoreLogin(config, 'https://api.new.example', fetcher)).toBe(false)
  expect(data.size).toBe(0)
  expect(new URL(replace.mock.calls[0]![0]).pathname).toBe('/api/auth/domain/start')
})
