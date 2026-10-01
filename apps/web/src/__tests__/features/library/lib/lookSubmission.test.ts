// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setSignedIn } from '../../../../auth/loginPrompt'
import {
  discardPendingSubmission,
  hasPendingSubmission,
  preservePendingSubmissionForLogin,
} from '../../../../auth/pendingSubmission'
import { resumePendingSubmission } from '../../../../auth/resumePendingSubmission'
import { useActiveLook } from '../../../../features/library/lib/activeLook'
import {
  cancelLookSubmission,
  submitWithLook,
  useLookSubmission,
} from '../../../../features/library/lib/lookSubmit'
import type { LookItem } from '../../../../features/library/lib/looks'
import { useLibraryStore } from '../../../../features/library/store'
import {
  createDefaultOpenAIByokProfile,
  DEFAULT_SETTINGS,
  normalizeSettings,
} from '../../../../lib/apiProfiles'
import { setClientStorageScope } from '../../../../lib/authScope'
import { setChannels } from '../../../../lib/channels/channelStore'
import { bootstrapClientCapabilities } from '../../../../lib/clientCapabilities'
import { getSelectedImageMentionLabel } from '../../../../lib/promptImageMentions'
import { useStore } from '../../../../store'
import { DEFAULT_PARAMS } from '../../../../types'

const storage = vi.hoisted(() => ({
  images: new Map<string, { id: string; dataUrl: string }>(),
  read: undefined as undefined | (() => Promise<void>),
  write: undefined as undefined | (() => Promise<void>),
}))
vi.mock('../../../../lib/db', async (original) => ({
  ...(await original<typeof import('../../../../lib/db')>()),
  getImage: async (id: string) => {
    await storage.read?.()
    return storage.images.get(id)
  },
  storeImage: async (dataUrl: string) => {
    await storage.write?.()
    const id =
      [...storage.images.values()].find((x) => x.dataUrl === dataUrl)?.id ?? crypto.randomUUID()
    storage.images.set(id, { id, dataUrl })
    return id
  },
  putTask: async () => {},
}))

function look(references: LookItem['references'] = []): LookItem {
  return {
    skillName: 'look-test',
    origin: 'builtin',
    name: 'Test',
    description: '',
    purpose: 'scene',
    model: createDefaultOpenAIByokProfile().selectedModelId,
    size: '1024x1024',
    slotCount: 1,
    cover: null,
    references,
  }
}

beforeEach(async () => {
  await bootstrapClientCapabilities(false, '')
  setSignedIn(false)
  setClientStorageScope(null)
  setChannels([])
  storage.images.clear()
  storage.read = undefined
  storage.write = undefined
  vi.stubGlobal(
    'Image',
    class {
      naturalWidth = 100
      naturalHeight = 100
      onload?: () => void
      onerror?: () => void
      set src(value: string) {
        queueMicrotask(() => (value.includes('corrupt') ? this.onerror?.() : this.onload?.()))
      }
    },
  )
  useStore.setState({
    settings: normalizeSettings({
      ...DEFAULT_SETTINGS,
      clearInputAfterSubmit: false,
      profiles: [createDefaultOpenAIByokProfile({ apiKey: 'test-key' })],
      activeProfileId: 'default-openai',
    }),
    prompt: 'my words',
    inputImages: [
      {
        id: 'missing',
        dataUrl:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZQAAAABJRU5ErkJggg==',
      },
    ],
    params: { ...DEFAULT_PARAMS, n: 1 },
    slotValues: {},
    maskDraft: null,
    tasks: [],
  })
  useLibraryStore.setState({
    assets: [
      {
        id: 'asset',
        name: 'Product',
        kind: 'product',
        views: [{ imageId: 'missing', label: 'front', source: 'upload' }],
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: 1,
      },
    ],
  })
})
afterEach(async () => {
  cancelLookSubmission()
  await discardPendingSubmission()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  useActiveLook.getState().set(null)
})

describe('template submission through generation entry', () => {
  it('does not submit when a required cached image is missing', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected request'))
    expect(await submitWithLook(look(), 'template')).toBe(false)
    expect(useStore.getState().tasks).toHaveLength(0)
    expect(fetcher).not.toHaveBeenCalled()
    expect(useStore.getState().prompt).toBe('my words')
    expect(useStore.getState().toast?.message).toContain('Product')
  })
})

it('freezes the submission and preserves a newer draft while preventing duplicate sends', async () => {
  const imageId = crypto.randomUUID()
  const dataUrl =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZQAAAABJRU5ErkJggg=='
  storage.images.set(imageId, { id: imageId, dataUrl })
  useStore.setState({ inputImages: [{ id: imageId, dataUrl }] })
  const assets = useLibraryStore.getState().assets
  useLibraryStore.setState({
    assets: assets.map((asset) => ({
      ...asset,
      views: [{ imageId, label: 'front', source: 'upload' }],
    })),
  })
  let release!: () => void
  storage.read = () =>
    new Promise<void>((resolve) => {
      release = resolve
    })
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline after task creation'))
  const template = look()
  useActiveLook.getState().set(template)
  const sending = submitWithLook(template, 'template')
  await vi.waitFor(() => expect(release).toBeDefined())
  const repeated = submitWithLook(template, 'template')
  useStore.getState().setPrompt('next draft')
  useStore.getState().setParams({ n: 3 })
  useActiveLook.getState().set({ ...template, name: 'Next template' })
  storage.read = undefined
  release()
  expect(await sending).toBe(true)
  expect(await repeated).toBe(false)
  expect(useStore.getState().tasks).toHaveLength(1)
  expect(useStore.getState().tasks[0].prompt).toContain('my words')
  expect(useStore.getState().tasks[0].params.n).toBe(1)
  expect(useStore.getState().prompt).toBe('next draft')
  expect(useActiveLook.getState().look?.name).toBe('Next template')
})

it('leaving generation while images load cancels before any task is created', async () => {
  const imageId = crypto.randomUUID()
  const dataUrl =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZQAAAABJRU5ErkJggg=='
  storage.images.set(imageId, { id: imageId, dataUrl })
  useStore.setState({
    inputImages: [{ id: imageId, dataUrl }],
    appMode: 'image',
    createTarget: 'generate',
  })
  useLibraryStore.setState({
    assets: useLibraryStore.getState().assets.map((asset) => ({
      ...asset,
      views: [{ imageId, label: 'front', source: 'upload' }],
    })),
  })
  let release!: () => void
  storage.read = () =>
    new Promise<void>((resolve) => {
      release = resolve
    })
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('unexpected generation'))
  const sending = submitWithLook(look(), 'template')
  await vi.waitFor(() => expect(release).toBeDefined())
  useStore.getState().setAppMode('library')
  storage.read = undefined
  release()
  expect(await sending).toBe(false)
  expect(useStore.getState().tasks).toHaveLength(0)
  expect(fetcher).not.toHaveBeenCalled()
  expect(useStore.getState().prompt).toBe('my words')
})

function seedImage(
  dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZQAAAABJRU5ErkJggg==',
) {
  const imageId = crypto.randomUUID()
  storage.images.set(imageId, { id: imageId, dataUrl })
  useStore.setState({
    inputImages: [{ id: imageId, dataUrl }],
    appMode: 'image',
    createTarget: 'generate',
  })
  useLibraryStore.setState({
    assets: useLibraryStore.getState().assets.map((asset) => ({
      ...asset,
      views: [{ imageId, label: 'front', source: 'upload' }],
    })),
  })
  return imageId
}

it('rejects corrupt required image bytes before generation', async () => {
  seedImage('data:image/png;base64,corrupt')
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('unexpected generation'))
  expect(await submitWithLook(look(), 'template')).toBe(false)
  expect(useStore.getState().tasks).toHaveLength(0)
  expect(fetcher).not.toHaveBeenCalled()
})

it('cancels during persistence and an old completion cannot unlock the next preparation', async () => {
  seedImage()
  const releases: Array<() => void> = []
  storage.write = () => new Promise<void>((resolve) => releases.push(resolve))
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('unexpected generation'))
  const first = submitWithLook(look(), 'first')
  await vi.waitFor(() => expect(releases).toHaveLength(1))
  cancelLookSubmission()
  const next = submitWithLook(look(), 'next')
  await vi.waitFor(() => expect(releases).toHaveLength(2))
  releases[0]()
  expect(await first).toBe(false)
  expect(useLookSubmission.getState().submitting).toBe(true)
  cancelLookSubmission()
  releases[1]()
  expect(await next).toBe(false)
  expect(useStore.getState().tasks).toHaveLength(0)
  expect(fetcher).not.toHaveBeenCalled()
  expect(useStore.getState().prompt).toBe('my words')
})

it('times out a stalled required image and releases the preparation lock', async () => {
  seedImage()
  storage.read = () => new Promise<void>(() => {})
  vi.useFakeTimers()
  const sending = submitWithLook(look(), 'template')
  await vi.advanceTimersByTimeAsync(30_000)
  expect(await sending).toBe(false)
  expect(useLookSubmission.getState().submitting).toBe(false)
  expect(useStore.getState().tasks).toHaveLength(0)
  expect(useStore.getState().toast?.type).toBe('error')
})

async function prepareLogin() {
  seedImage()
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(Response.json({ 'accounts:login': true }))
  await bootstrapClientCapabilities(true, '')
  fetcher.mockRejectedValue(new Error('offline after creation'))
  setChannels([
    {
      id: 'test',
      kind: 'openai-queue',
      label: 'Test',
      models: [{ id: look().model, label: 'Image', capabilities: ['generate', 'edit'] }],
      defaults: { apiMode: 'images', timeout: 600 },
    },
  ])
  useStore.setState({
    settings: normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [
        {
          id: 'builtin-test',
          source: 'builtin-edge',
          channelId: 'test',
          selectedModelId: look().model,
        },
      ],
      activeProfileId: 'builtin-test',
    }),
  })
  expect(await submitWithLook(look(), 'original template')).toBe(false)
  expect(await hasPendingSubmission()).toBe(true)
  expect(useStore.getState().tasks).toHaveLength(0)
}

it('resumes the original frozen template once after login and preserves the later draft', async () => {
  await prepareLogin()
  useStore.getState().setPrompt('next draft')
  setSignedIn(true)
  setClientStorageScope('alice')
  await Promise.all([resumePendingSubmission(), resumePendingSubmission()])
  expect(useStore.getState().tasks).toHaveLength(1)
  expect(useStore.getState().tasks[0].prompt).toContain('original template')
  expect(useStore.getState().tasks[0].prompt).toContain('my words')
  expect(useStore.getState().prompt).toBe('next draft')
})

it('cancelling login or leaving the generator drops the pending template', async () => {
  await prepareLogin()
  await discardPendingSubmission()
  setSignedIn(true)
  await resumePendingSubmission()
  expect(useStore.getState().tasks).toHaveLength(0)
  setSignedIn(false)
  await prepareLogin()
  useStore.getState().setAppMode('library')
  setSignedIn(true)
  await resumePendingSubmission()
  expect(useStore.getState().tasks).toHaveLength(0)
  expect(useStore.getState().prompt).toBe('my words')
})

it('a material mention follows the selected sheet even when its front is also a template reference', async () => {
  const front = seedImage()
  const sheet = crypto.randomUUID()
  storage.images.set(sheet, { id: sheet, dataUrl: storage.images.get(front)!.dataUrl })
  useLibraryStore.setState({
    assets: useLibraryStore.getState().assets.map((asset) => ({
      ...asset,
      views: [...asset.views, { imageId: sheet, label: 'sheet', source: 'upload' }],
    })),
  })
  useStore.getState().setPrompt(`Edit ${getSelectedImageMentionLabel(0)}`)
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline after task creation'))
  expect(await submitWithLook(look([{ kind: 'image', imageId: front }]), 'template')).toBe(true)
  expect(useStore.getState().tasks[0].inputImageIds).toEqual([sheet, front])
  expect(useStore.getState().tasks[0].prompt).toContain(`Edit ${getSelectedImageMentionLabel(0)}`)
})

it('failed login resumption leaves an empty newer draft and its changed parameters intact', async () => {
  await prepareLogin()
  useStore.setState({ prompt: '', inputImages: [], params: { ...DEFAULT_PARAMS, n: 3 } })
  setChannels([])
  setSignedIn(true)
  await resumePendingSubmission()
  expect(useStore.getState().tasks).toHaveLength(0)
  expect(useStore.getState().prompt).toBe('')
  expect(useStore.getState().inputImages).toEqual([])
  expect(useStore.getState().params.n).toBe(3)
})

it('login resumption holds the same preparation gate and can stop during persistence', async () => {
  await prepareLogin()
  setSignedIn(true)
  setClientStorageScope('alice')
  let release!: () => void
  storage.write = () =>
    new Promise<void>((resolve) => {
      release = resolve
    })
  const resuming = resumePendingSubmission()
  await vi.waitFor(() => expect(release).toBeDefined())
  expect(useLookSubmission.getState().submitting).toBe(true)
  expect(await submitWithLook(look(), 'duplicate')).toBe(false)
  cancelLookSubmission()
  release()
  await resuming
  expect(useStore.getState().tasks).toHaveLength(0)
  expect(useLookSubmission.getState().submitting).toBe(false)
})

it('sends eight materials and eight references at the limit, but never sends a seventeenth', async () => {
  const first = seedImage()
  const dataUrl = storage.images.get(first)!.dataUrl
  const ids = Array.from({ length: 17 }, () => crypto.randomUUID())
  for (const id of ids) storage.images.set(id, { id, dataUrl })
  const images = ids.slice(0, 8).map((id) => ({ id, dataUrl }))
  useStore.setState({ inputImages: images })
  useLibraryStore.setState({
    assets: images.map(({ id }) => ({
      id,
      name: id,
      kind: 'product',
      views: [{ imageId: id, label: 'front', source: 'upload' }],
      createdAt: 1,
      updatedAt: 1,
      lastUsedAt: 1,
    })),
  })
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    if (String(url).startsWith('data:')) {
      const response = new Response()
      response.blob = async () => new Blob([new Uint8Array([1])], { type: 'image/png' })
      return response
    }
    throw new Error('offline after creation')
  })
  const template = {
    ...look(ids.slice(8, 16).map((imageId) => ({ kind: 'image' as const, imageId }))),
    slotCount: 8,
  }
  expect(await submitWithLook(template, 'template')).toBe(true)
  expect(useStore.getState().tasks[0].inputImageIds).toEqual(ids.slice(0, 16))
  await vi.waitFor(() =>
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/images/edits'))).toBe(true),
  )
  const request = fetcher.mock.calls.find(([url]) => String(url).includes('/images/edits'))
  expect(request).toBeDefined()
  expect((request![1]!.body as FormData).getAll('image[]')).toHaveLength(16)
  // A new intentional send is allowed after handoff, even with the same input.
  expect(await submitWithLook(template, 'template')).toBe(true)
  expect(useStore.getState().tasks).toHaveLength(2)
  fetcher.mockClear()
  expect(
    await submitWithLook(
      { ...template, references: ids.slice(8).map((imageId) => ({ kind: 'image', imageId })) },
      'too many',
    ),
  ).toBe(false)
  expect(useStore.getState().tasks).toHaveLength(2)
  expect(useStore.getState().toast?.message).toContain('17')
  await vi.waitFor(() =>
    expect(useStore.getState().tasks.every((task) => task.status === 'error')).toBe(true),
  )
})

it('a full-page departure discards the pending template while login navigation preserves it', async () => {
  await prepareLogin()
  window.dispatchEvent(new Event('pagehide'))
  expect(await hasPendingSubmission()).toBe(false)
  await prepareLogin()
  preservePendingSubmissionForLogin()
  window.dispatchEvent(new Event('pagehide'))
  expect(await hasPendingSubmission()).toBe(true)
  setSignedIn(true)
  setClientStorageScope('alice')
  await resumePendingSubmission()
  expect(useStore.getState().tasks).toHaveLength(1)
})

it('login navigation exemption is consumed before a later departure from the back cache', async () => {
  await prepareLogin()
  preservePendingSubmissionForLogin()
  window.dispatchEvent(new Event('pagehide'))
  expect(await hasPendingSubmission()).toBe(true)
  window.dispatchEvent(new Event('pageshow'))
  window.dispatchEvent(new Event('pagehide'))
  expect(await hasPendingSubmission()).toBe(false)
})
