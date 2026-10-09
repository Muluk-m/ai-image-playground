// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import MediaImage from '../../components/MediaImage'
import ProjectCover from '../../features/canvas/components/ProjectCover'
import { scopedStorageName } from '../../lib/authScope'
import { BASE_DB_NAME } from '../../lib/db'
import { bffBaseUrl } from '../../lib/runtimeConfig'

type Change = { source: string; storageScope: string; backend: string }
const fixture = vi.hoisted(() => ({
  resolve: vi.fn<(source: string) => Promise<string>>(),
  localPreview: vi.fn<() => Promise<string | undefined> | undefined>(),
  upload: vi.fn(),
  releases: new Set<(change: { sources: string[]; storageScope: string }) => void>(),
  listeners: new Set<(change: Change) => void>(),
}))
vi.mock('../../lib/cloudMedia', () => ({
  mediaIdentity: (source?: string) =>
    source?.startsWith('aip-media:') ? source.slice(10) : undefined,
  resolveMediaSource: fixture.resolve,
}))
vi.mock('../../lib/localAttachmentSources', () => ({
  localAttachmentIdentity: (source: string) =>
    source.startsWith('aip-local:') ? source.slice(10) : undefined,
  localAttachmentPreview: fixture.localPreview,
  localAttachmentFailure: () => undefined,
  readAttachmentUpload: fixture.upload,
  onLocalAttachmentReleased: (
    listener: (change: { sources: string[]; storageScope: string }) => void,
  ) => {
    fixture.releases.add(listener)
    return () => fixture.releases.delete(listener)
  },
  onLocalAttachmentUploadChanged: (listener: (change: Change) => void) => {
    fixture.listeners.add(listener)
    return () => fixture.listeners.delete(listener)
  },
}))
const source = 'aip-media:11000000-0000-4000-8000-000000000002'
function changed() {
  for (const listener of fixture.listeners)
    listener({ source, storageScope: scopedStorageName(BASE_DB_NAME), backend: bffBaseUrl() })
}
afterEach(() => {
  fixture.resolve.mockReset()
  fixture.localPreview.mockReset()
  fixture.upload.mockReset()
})

it('ignores an older failed resolution after the newer preview succeeded', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  let rejectOld!: (error: Error) => void
  fixture.resolve
    .mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectOld = reject
        }),
    )
    .mockResolvedValue('data:image/png;base64,AQID')
  const failure = vi.fn()
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    await act(async () => root.render(<MediaImage src={source} onResolveError={failure} />))
    await act(async () => changed())
    expect(host.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AQID')
    await act(async () => rejectOld(new Error('old request failed')))
    expect(failure).not.toHaveBeenCalled()
    expect(host.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AQID')
  } finally {
    await act(async () => root.unmount())
  }
})

it('keeps cover subscriptions alive so a successful attachment retry restores the image', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  fixture.resolve.mockRejectedValue(new TypeError('network interrupted'))
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    await act(async () => root.render(<ProjectCover source={source} chat />))
    expect(host.querySelector('[role=status]')).toBeNull()
    expect(fixture.listeners.size).toBe(2)
    fixture.resolve.mockResolvedValue('data:image/png;base64,AQID')
    await act(async () => changed())
    await act(async () => host.querySelectorAll('img')[1]!.dispatchEvent(new Event('load')))
    expect(host.querySelectorAll('img')[1]!.className).not.toContain('opacity-0')
    expect(host.querySelector('[role=status]')).toBeNull()
  } finally {
    await act(async () => root.unmount())
  }
})

it('does not restore a released attachment when its local thumbnail arrives late', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  let resolvePreview!: (value: string) => void
  fixture.localPreview.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolvePreview = resolve
      }),
  )
  const local = 'aip-local:11000000-0000-4000-8000-000000000002'
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    await act(async () => root.render(<MediaImage src={local} />))
    await act(async () => {
      for (const listener of fixture.releases)
        listener({ sources: [local], storageScope: scopedStorageName(BASE_DB_NAME) })
      resolvePreview('data:image/webp;base64,late')
    })
    expect(host.querySelector('img')?.getAttribute('src')).toBeNull()
    expect(fixture.resolve).not.toHaveBeenCalled()
  } finally {
    await act(async () => root.unmount())
  }
})

it.each([
  true,
  false,
])('waits for a pending local thumbnail before reporting cloud failure: %s', async (localSucceeds) => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  let resolvePreview!: (value: string | undefined) => void
  fixture.localPreview.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolvePreview = resolve
      }),
  )
  fixture.upload.mockResolvedValue({
    state: 'ready',
    result: { id: '11000000-0000-4000-8000-000000000002' },
  })
  fixture.resolve.mockRejectedValue(new Error('cloud unavailable'))
  const failure = vi.fn()
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        <MediaImage
          src="aip-local:11000000-0000-4000-8000-000000000002"
          onResolveError={failure}
        />,
      ),
    )
    expect(fixture.resolve).toHaveBeenCalledOnce()
    expect(failure).not.toHaveBeenCalled()
    await act(async () =>
      resolvePreview(localSucceeds ? 'data:image/webp;base64,local' : undefined),
    )
    if (localSucceeds) {
      expect(failure).not.toHaveBeenCalled()
      expect(host.querySelector('img')?.getAttribute('src')).toContain('local')
    } else expect(failure).toHaveBeenCalledOnce()
  } finally {
    await act(async () => root.unmount())
  }
})
