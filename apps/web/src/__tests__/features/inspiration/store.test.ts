import { beforeEach, describe, expect, it } from 'vitest'
import { useInspirationStore } from '../../../features/inspiration/store'
import type { InspirationItem } from '../../../features/inspiration/types'

function makeItem(id: string, title: string, category = '头像'): InspirationItem {
  return {
    id,
    title,
    prompt: `prompt for ${id}`,
    thumbnailUrl: `https://example.com/${id}.jpg`,
    params: { size: '1024x1024' },
    recommendedModel: 'gpt-image-2',
    recommendedProvider: 'openai-compat',
    category,
  }
}

describe('useInspirationStore', () => {
  beforeEach(() => {
    useInspirationStore.setState({
      items: [],
      categories: [],
      status: 'idle',
      remoteError: null,
      panelOpen: false,
      selectedProvider: 'all',
      selectedCategory: null,
      searchKeyword: '',
      detailItemId: null,
    })
  })

  it('setRemoteItems replaces items and derives categories from data', () => {
    useInspirationStore
      .getState()
      .setRemoteItems([makeItem('a', 'A', '头像'), makeItem('b', 'B', '海报')])
    const { items, categories } = useInspirationStore.getState()
    expect(items.map((i) => i.id)).toEqual(['a', 'b'])
    expect(categories).toEqual(['头像', '海报'].sort((x, y) => x.localeCompare(y, 'zh-CN')))
  })

  it('setRemoteItems prefers explicit categories over derived', () => {
    useInspirationStore
      .getState()
      .setRemoteItems([makeItem('a', 'A', '头像')], ['Custom A', 'Custom B'])
    expect(useInspirationStore.getState().categories).toEqual(['Custom A', 'Custom B'])
  })

  it('setProvider switches provider filter and resets selectedCategory', () => {
    const s = useInspirationStore.getState()
    s.setCategory('头像')
    expect(useInspirationStore.getState().selectedCategory).toBe('头像')
    s.setProvider('gemini')
    expect(useInspirationStore.getState().selectedProvider).toBe('gemini')
    expect(useInspirationStore.getState().selectedCategory).toBeNull()
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
