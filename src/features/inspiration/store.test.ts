import { describe, expect, it, beforeEach } from 'vitest'
import { useInspirationStore } from './store'
import type { InspirationItem } from './types'

function makeItem(id: string, title: string): InspirationItem {
  return {
    id,
    title,
    prompt: `prompt for ${id}`,
    thumbnailUrl: `https://example.com/${id}.jpg`,
    params: { size: '1024x1024' },
    recommendedModel: 'gpt-image-2',
    recommendedProvider: 'openai-compat',
    category: '头像',
  }
}

describe('useInspirationStore merge', () => {
  beforeEach(() => {
    // 重置 store 到初始 + builtin
    useInspirationStore.setState({
      items: [],
      categories: [],
      status: 'idle',
      remoteError: null,
      panelOpen: false,
      selectedCategory: null,
      searchKeyword: '',
      detailItemId: null,
    })
    useInspirationStore.getState().loadBuiltin()
  })

  it('loadBuiltin populates items with source=builtin', () => {
    const items = useInspirationStore.getState().items
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((i) => i.source === 'builtin')).toBe(true)
  })

  it('setRemoteItems with new id appends and marks source=remote', () => {
    const before = useInspirationStore.getState().items.length
    useInspirationStore.getState().setRemoteItems([makeItem('remote-x', 'Remote X')])
    const items = useInspirationStore.getState().items
    expect(items.length).toBe(before + 1)
    const remoteX = items.find((i) => i.id === 'remote-x')
    expect(remoteX?.source).toBe('remote')
  })

  it('setRemoteItems with same id as builtin overrides and marks source=remote', () => {
    const builtinId = useInspirationStore.getState().items[0].id
    useInspirationStore.getState().setRemoteItems([
      { ...makeItem(builtinId, 'Override Title'), id: builtinId, title: 'Override Title' },
    ])
    const items = useInspirationStore.getState().items
    const overridden = items.find((i) => i.id === builtinId)
    expect(overridden?.title).toBe('Override Title')
    expect(overridden?.source).toBe('remote')
  })

  it('openPanel / closePanel toggles + closing clears detailItemId', () => {
    const s = useInspirationStore.getState()
    s.openPanel()
    expect(useInspirationStore.getState().panelOpen).toBe(true)
    s.showDetail('foo')
    expect(useInspirationStore.getState().detailItemId).toBe('foo')
    s.closePanel()
    expect(useInspirationStore.getState().panelOpen).toBe(false)
    expect(useInspirationStore.getState().detailItemId).toBeNull()
  })
})
