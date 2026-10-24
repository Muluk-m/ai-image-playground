import type { ClientCapabilityKey } from '@image-playground/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bootstrapClientCapabilities,
  getClientCapabilityManifest,
  isClientCapabilityEnabled,
  supportsCanvasPendingMedia,
  supportsProjectDocumentIdentity,
} from '../../lib/clientCapabilities'
import { allCapabilitiesOff } from '../fixtures/capabilities'

const yjsSelfCheck = vi.hoisted(() => ({ ok: true }))
vi.mock('@image-playground/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@image-playground/shared')>()),
  canvasUploadConflictsSupported: () => yjsSelfCheck.ok,
}))

afterEach(async () => {
  yjsSelfCheck.ok = true
  vi.unstubAllGlobals()
  await bootstrapClientCapabilities(false, '')
})

describe('client capability bootstrap', () => {
  it('loads only the BFF manifest and resolves enabled capabilities', async () => {
    const fetchSpy = vi.fn(async () =>
      Response.json({
        ...allCapabilitiesOff(),
        'accounts:login': true,
        'accounts:self-register': true,
        'accounts:sync': true,
        projectDocumentIdentity: true,
        canvasPendingMedia: true,
      }),
    )
    vi.stubGlobal('fetch', fetchSpy)

    await bootstrapClientCapabilities(true, 'https://bff.example.com/')

    expect(isClientCapabilityEnabled('accounts:login')).toBe(true)
    expect(isClientCapabilityEnabled('accounts:self-register')).toBe(true)
    expect(getClientCapabilityManifest()).not.toHaveProperty('generation:byok')
    expect(getClientCapabilityManifest()).not.toHaveProperty('operator:console')
    expect(supportsProjectDocumentIdentity()).toBe(true)
    expect(supportsCanvasPendingMedia()).toBe(true)
  })

  it('keeps pending canvas media off while the server advertises it as false', async () => {
    // 分阶段上线的第一阶段：服务端带着这个键但值为 false，客户端照旧等图片上云再同步。
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          ...allCapabilitiesOff(),
          projectDocumentIdentity: true,
          canvasPendingMedia: false,
        }),
      ),
    )

    await bootstrapClientCapabilities(true, 'https://bff.example.com')

    expect(supportsProjectDocumentIdentity()).toBe(true)
    expect(supportsCanvasPendingMedia()).toBe(false)
  })

  it('keeps pending canvas media off when the installed yjs fails the conflict self-check', async () => {
    // 服务端开了开关，但 yjs 内部结构变了、并发覆盖补不回来：不冒险先发文档。
    yjsSelfCheck.ok = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          ...allCapabilitiesOff(),
          projectDocumentIdentity: true,
          canvasPendingMedia: true,
        }),
      ),
    )

    await bootstrapClientCapabilities(true, 'https://bff.example.com')

    expect(supportsProjectDocumentIdentity()).toBe(true)
    expect(supportsCanvasPendingMedia()).toBe(false)
  })

  it('keeps known capabilities enabled when an older server omits newer keys', async () => {
    const legacyManifest: Partial<Record<ClientCapabilityKey, boolean>> = {
      ...allCapabilitiesOff(),
      'accounts:login': true,
      'billing:credits': true,
    }
    delete legacyManifest['agent:chat']
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(legacyManifest)),
    )

    await bootstrapClientCapabilities(true, 'https://bff.example.com')

    expect(isClientCapabilityEnabled('accounts:login')).toBe(true)
    expect(isClientCapabilityEnabled('billing:credits')).toBe(true)
    expect(isClientCapabilityEnabled('agent:chat')).toBe(false)
    expect(supportsProjectDocumentIdentity()).toBe(false)
    expect(supportsCanvasPendingMedia()).toBe(false)
  })

  it('fails closed for a disabled backend or a malformed capability value', async () => {
    await bootstrapClientCapabilities(false, '')
    expect(Object.values(getClientCapabilityManifest()).every((value) => value === false)).toBe(
      true,
    )

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ 'accounts:login': 'true' })),
    )
    await bootstrapClientCapabilities(true, '')

    expect(Object.values(getClientCapabilityManifest()).every((value) => value === false)).toBe(
      true,
    )
  })

  it('bounds a stalled capability request and fails closed', async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(() => new Promise(() => {})),
      )
      const boot = bootstrapClientCapabilities(true, '')
      await vi.advanceTimersByTimeAsync(30_000)
      await boot
      expect(isClientCapabilityEnabled('accounts:login')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a timed-out required startup manifest so the UI can retry', async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(() => new Promise(() => {})),
      )
      const boot = bootstrapClientCapabilities(true, '', true)
      const outcome = expect(boot).rejects.toThrow('capability_request_timeout')
      await vi.advanceTimersByTimeAsync(30_000)
      await outcome
      expect(fetch).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries with longer timeouts before failing startup', async () => {
    vi.useFakeTimers()
    try {
      const fetchMock = vi
        .fn()
        .mockReturnValueOnce(new Promise(() => {}))
        .mockReturnValueOnce(new Promise(() => {}))
        .mockResolvedValueOnce(Response.json({ 'accounts:login': true }))
      vi.stubGlobal('fetch', fetchMock)
      const boot = bootstrapClientCapabilities(true, '', true)
      const settled = vi.fn()
      void boot.then(settled, settled)
      await vi.advanceTimersByTimeAsync(5000)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      // The second attempt waits 10s, not another 5s.
      await vi.advanceTimersByTimeAsync(9000)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1000)
      await boot
      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(isClientCapabilityEnabled('accounts:login')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
