// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import type { VideoModelSupport } from '@image-playground/shared'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ProjectNavigation from '../../components/ProjectNavigation'
import SearchField from '../../components/patterns/SearchField'
import CanvasVideoParams from '../../features/canvas/components/CanvasVideoParams'
import NodeAssetPicker from '../../features/canvas/components/NodeAssetPicker'
import { useCanvasProjectStore } from '../../features/canvas/projectStore'
import { useLibraryStore } from '../../features/library/store'
import type { AssetRecord } from '../../features/library/types'
import { INITIAL_VIDEO_DRAFT } from '../../features/video/store'
import type { VideoDraft } from '../../features/video/types'
import { useStore } from '../../store'
import { stubPointerApis } from '../helpers/radix'

const ensureImageCachedMock = vi.hoisted(() => vi.fn<(id: string) => Promise<string | null>>())

vi.mock('../../lib/sync/assetImages', () => ({
  ensureAssetImage: vi.fn(async () => {}),
}))

vi.mock('../../store', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../store')>()
  return {
    ...mod,
    ensureImageCached: (id: string) => ensureImageCachedMock(id),
  }
})

const mockVideoSupport: VideoModelSupport = {
  label: 'Test Video',
  aspectRatios: ['16:9', '9:16'],
  durations: [5, 10],
  resolutions: ['720p', '1080p'],
  resolutionMultipliers: { '720p': 1, '1080p': 1.6 },
  firstFrame: true,
  lastFrame: false,
  extend: false,
  edit: false,
  voices: { max: 2 },
  typicalSeconds: 40,
  tagline: 'Test',
}

vi.mock('../../lib/channels/videoChannels', () => ({
  videoModelOptions: () => [
    {
      modelId: 'test-video',
      label: 'Test Video',
      support: mockVideoSupport,
    },
  ],
}))

function setNativeValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  stubPointerApis()
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('SearchField clear & Escape behavior', () => {
  it('clears on button click and Escape, but ignores Escape during IME composition', async () => {
    const onClear = vi.fn()
    const parentKeyDown = vi.fn()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () =>
        root.render(
          <div onKeyDown={parentKeyDown}>
            <SearchField value="hello" onChange={() => {}} onClear={onClear} />
          </div>,
        ),
      )

      const input = host.querySelector<HTMLInputElement>('input[type="search"]')!
      expect(input).toBeTruthy()
      const clearBtn = host.querySelector<HTMLButtonElement>('button[type="button"]')!
      expect(clearBtn).toBeTruthy()

      // IME composing Escape must not clear
      await act(async () => {
        const imeEvent = new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        })
        Object.defineProperty(imeEvent, 'isComposing', { value: true })
        input.dispatchEvent(imeEvent)
      })
      expect(onClear).not.toHaveBeenCalled()
      parentKeyDown.mockClear()

      // Normal Escape clears and stops propagation
      await act(async () => {
        input.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        )
      })
      expect(onClear).toHaveBeenCalledTimes(1)
      expect(parentKeyDown).not.toHaveBeenCalled()

      // Clear button click calls onClear
      await act(async () => clearBtn.click())
      expect(onClear).toHaveBeenCalledTimes(2)
    } finally {
      await act(async () => root.unmount())
    }
  })
})

describe('Radix overlay Escape coordination', () => {
  it('NodeAssetPicker clears search on first Escape and closes on second Escape', async () => {
    const onClose = vi.fn()
    vi.spyOn(useLibraryStore.getState(), 'loadAssets').mockResolvedValue(undefined)
    useLibraryStore.setState({ assets: [] })

    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () => root.render(<NodeAssetPicker onClose={onClose} onChoose={() => {}} />))
      const input = document.querySelector<HTMLInputElement>(
        '[role="dialog"] input[type="search"]',
      )!
      expect(input).toBeTruthy()

      await act(async () => setNativeValue(input, 'cat'))
      expect(input.value).toBe('cat')

      // First Escape clears search without closing
      await act(async () => {
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        )
      })
      expect(input.value).toBe('')
      expect(onClose).not.toHaveBeenCalled()

      // Second Escape closes the sheet
      await act(async () => {
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        )
      })
      expect(onClose).toHaveBeenCalledTimes(1)
    } finally {
      await act(async () => root.unmount())
    }
  })

  it('ProjectNavigation clears search on first Escape before closing popover', async () => {
    useCanvasProjectStore.setState({
      projects: [],
      activeId: null,
      cloudCatalog: {},
      cloudLoading: false,
      cloudError: null,
      loaded: true,
    })
    vi.spyOn(useCanvasProjectStore.getState(), 'refreshCloud').mockResolvedValue(undefined)

    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () => root.render(<ProjectNavigation />))
      const trigger = host.querySelector<HTMLButtonElement>('[aria-label^="切换项目"]')!
      await act(async () => trigger.click())

      const input = document.querySelector<HTMLInputElement>('input[type="search"]')!
      expect(input).toBeTruthy()
      await act(async () => setNativeValue(input, 'demo'))
      expect(input.value).toBe('demo')

      // First Escape clears search and keeps popover open
      await act(async () => {
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        )
      })
      expect(document.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe('')

      // Second Escape closes popover
      await act(async () => {
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        )
      })
      expect(document.querySelector('input[type="search"]')).toBeNull()
    } finally {
      await act(async () => root.unmount())
    }
  })
})

describe('libraryStore.attachAsset targetZone, imageId and shouldCommit', () => {
  const sampleAsset: AssetRecord = {
    id: 'asset-1',
    name: 'Mug',
    views: [
      { imageId: 'img-a', label: 'front', source: 'upload' },
      { imageId: 'img-b', label: 'side', source: 'upload' },
    ],
    createdAt: 1,
    updatedAt: 1,
  }

  beforeEach(() => {
    useLibraryStore.setState({ assets: [sampleAsset], onLibraryPage: false })
    useStore.setState({
      createTarget: 'batch',
      inputImages: [],
      batchSharedImages: [],
    })
  })

  it('attaches to batchSharedImages when targetZone is shared and respects imageId', async () => {
    ensureImageCachedMock.mockImplementation(async (id) => `data:image/png;base64,${id}`)

    const idx = await useLibraryStore
      .getState()
      .attachAsset(
        'asset-1',
        { limit: 4, acceptsReferences: true },
        { targetZone: 'shared', imageId: 'img-b' },
      )

    expect(idx).toBe(0)
    expect(useStore.getState().inputImages).toHaveLength(0)
    expect(useStore.getState().batchSharedImages.map((img) => img.id)).toEqual(['img-b'])
  })

  it('aborts stale async attach when shouldCommit returns false', async () => {
    let resolveImg!: (val: string) => void
    const started = new Promise<void>((markStarted) => {
      ensureImageCachedMock.mockImplementation(
        () =>
          new Promise<string>((resolve) => {
            resolveImg = resolve
            markStarted()
          }),
      )
    })

    let valid = true
    const pending = useLibraryStore.getState().attachAsset(
      'asset-1',
      { limit: 4, acceptsReferences: true },
      {
        targetZone: 'shared',
        imageId: 'img-a',
        shouldCommit: () => valid,
      },
    )

    await started
    valid = false
    resolveImg('data:image/png;base64,img-a')
    const idx = await pending

    expect(idx).toBeNull()
    expect(useStore.getState().batchSharedImages).toHaveLength(0)
    expect(useStore.getState().inputImages).toHaveLength(0)
  })
})

describe('CanvasVideoParams dirty state and reset', () => {
  it('shows reset button when modified and restores clamped defaults', async () => {
    const onChange = vi.fn()
    const modifiedDraft: VideoDraft = {
      ...INITIAL_VIDEO_DRAFT,
      model: 'test-video',
      duration: 10,
      aspectRatio: '9:16',
      resolution: '1080p',
      voices: ['voice-1'],
    }
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () =>
        root.render(
          <CanvasVideoParams
            hasFirstFrame={false}
            controlled={{ draft: modifiedDraft, onChange, support: mockVideoSupport }}
          />,
        ),
      )

      const trigger = host.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!
      expect(trigger).toBeTruthy()
      await act(async () => trigger.click())

      const resetBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
        (b) => /恢复默认|Reset/i.test(b.textContent ?? ''),
      )!
      expect(resetBtn).toBeTruthy()
      await act(async () => resetBtn.click())

      expect(onChange).toHaveBeenCalledWith({
        duration: 5,
        aspectRatio: '16:9',
        resolution: '720p',
        voices: [],
      })
    } finally {
      await act(async () => root.unmount())
    }
  })
})
