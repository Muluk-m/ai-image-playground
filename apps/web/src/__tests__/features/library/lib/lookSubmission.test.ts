// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useActiveLook } from '../../../../features/library/lib/activeLook'
import { submitWithLook } from '../../../../features/library/lib/lookSubmit'
import type { LookItem } from '../../../../features/library/lib/looks'
import { useLibraryStore } from '../../../../features/library/store'
import {
  createDefaultOpenAIByokProfile,
  DEFAULT_SETTINGS,
  normalizeSettings,
} from '../../../../lib/apiProfiles'
import { bootstrapClientCapabilities } from '../../../../lib/clientCapabilities'
import { useStore } from '../../../../store'
import { DEFAULT_PARAMS } from '../../../../types'

const storage = vi.hoisted(() => ({ images: new Map<string, { id: string; dataUrl: string }>() }))
vi.mock('../../../../lib/db', async (original) => ({
  ...(await original<typeof import('../../../../lib/db')>()),
  getImage: async (id: string) => storage.images.get(id),
  storeImage: async (dataUrl: string) => {
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
  storage.images.clear()
  useStore.setState({
    settings: normalizeSettings({
      ...DEFAULT_SETTINGS,
      clearInputAfterSubmit: false,
      profiles: [createDefaultOpenAIByokProfile({ apiKey: 'test-key' })],
      activeProfileId: 'default-openai',
    }),
    prompt: 'my words',
    inputImages: [{ id: 'missing', dataUrl: 'data:image/png;base64,YQ==' }],
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
afterEach(() => {
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
    expect(useStore.getState().toast?.message).toContain('missing')
  })
})
