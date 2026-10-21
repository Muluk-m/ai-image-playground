import { beforeEach, describe, expect, it } from 'vitest'
import { useInspirationStore } from '../../../features/inspiration/store'
import type { InspirationItem } from '../../../features/inspiration/types'

function makeItem(id: string, title: string, category = '头像'): InspirationItem {
  return {
    id,
    kind: 'showcase',
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
      selectedProvider: 'all',
      selectedCategory: null,
      selectedGroup: null,
      searchKeyword: '',
      detailItemId: null,
      detailFallback: null,
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
    s.setGroup('photo')
    s.setProvider('gemini')
    expect(useInspirationStore.getState().selectedProvider).toBe('gemini')
    expect(useInspirationStore.getState().selectedCategory).toBeNull()
    expect(useInspirationStore.getState().selectedGroup).toBeNull()
  })

  it('setGroup keeps the provider and category filters', () => {
    const s = useInspirationStore.getState()
    s.setProvider('gemini')
    s.setCategory('摄影与写实')
    s.setGroup('photo')
    expect(useInspirationStore.getState().selectedGroup).toBe('photo')
    expect(useInspirationStore.getState().selectedProvider).toBe('gemini')
    expect(useInspirationStore.getState().selectedCategory).toBe('摄影与写实')
  })

  it('keeps an offline detail separate when the remote list refreshes', () => {
    const seed = makeItem('offline', 'Offline case')
    useInspirationStore.getState().showDetail(seed.id, seed)
    useInspirationStore.getState().setRemoteItems([makeItem('online', 'Online case')])

    expect(useInspirationStore.getState().items.map((item) => item.id)).toEqual(['online'])
    expect(useInspirationStore.getState().detailFallback).toEqual(seed)
    useInspirationStore.getState().closeDetail()
    expect(useInspirationStore.getState().detailFallback).toBeNull()
  })
})
