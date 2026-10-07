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
  listeners: new Set<(change: Change) => void>(),
}))
vi.mock('../../lib/cloudMedia', () => ({
  mediaIdentity: (source?: string) =>
    source?.startsWith('aip-media:') ? source.slice(10) : undefined,
  resolveMediaSource: fixture.resolve,
}))
vi.mock('../../lib/localAttachmentSources', () => ({
  localAttachmentIdentity: () => undefined,
  localAttachmentFailure: () => undefined,
  readAttachmentUpload: vi.fn(),
  onLocalAttachmentReleased: () => () => {},
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
afterEach(() => fixture.resolve.mockReset())

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
