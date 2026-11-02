// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  disposeHashRoute,
  initHashRoute,
  isInspirationHash,
} from '../../../../features/inspiration/lib/hashRoute'
import { useInspirationStore } from '../../../../features/inspiration/store'
import type { InspirationItem } from '../../../../features/inspiration/types'
import { useStore } from '../../../../store'

function makeItem(id: string): InspirationItem {
  return {
    id,
    kind: 'showcase',
    title: id,
    prompt: 'prompt',
    thumbnailUrl: 'https://example.com/a.jpg',
    params: { size: 'auto' },
    recommendedModel: 'gpt-image-2',
    recommendedProvider: 'openai-compat',
    category: '摄影与写实',
  }
}

describe('inspiration hash route', () => {
  beforeEach(() => {
    disposeHashRoute()
    window.history.replaceState(null, '', '/workspace')
    useStore.setState({ appMode: 'image' })
    useInspirationStore.setState({
      status: 'ready',
      items: [makeItem('known')],
      detailItemId: null,
      detailFallback: null,
      selectedGroup: null,
    })
  })

  it('opens explore and the matching detail from #inspirations/<id>', async () => {
    window.history.replaceState(null, '', '/workspace#inspirations/known')
    initHashRoute()
    await vi.waitFor(() => expect(useInspirationStore.getState().detailItemId).toBe('known'))
    expect(useStore.getState().appMode).toBe('explore')
    expect(isInspirationHash()).toBe(true)
  })

  it('keeps a detail hash when explore is already open', () => {
    window.history.replaceState(null, '', '/workspace#inspirations/known')
    useStore.setState({ appMode: 'explore' })
    initHashRoute()
    useStore.setState({ appMode: 'explore', prompt: 'touched' })
    expect(window.location.hash).toBe('#inspirations/known')
  })

  it('opens explore without a detail when the id is missing and leaves the hash', async () => {
    window.history.replaceState(null, '', '/workspace#inspirations/missing')
    initHashRoute()
    await vi.waitFor(() => expect(useStore.getState().appMode).toBe('explore'))
    expect(useInspirationStore.getState().detailItemId).toBeNull()
    expect(window.location.hash).toBe('#inspirations/missing')
  })

  it('waits for an in-flight manifest before deciding the detail', async () => {
    useInspirationStore.setState({ status: 'loading-remote', items: [] })
    window.history.replaceState(null, '', '/workspace#inspirations/late')
    initHashRoute()
    expect(useStore.getState().appMode).toBe('explore')
    expect(useInspirationStore.getState().detailItemId).toBeNull()
    useInspirationStore.setState({ status: 'ready', items: [makeItem('late')] })
    await vi.waitFor(() => expect(useInspirationStore.getState().detailItemId).toBe('late'))
  })

  it('clears an inspiration hash when leaving explore', async () => {
    window.history.replaceState(null, '', '/workspace#inspirations/known')
    initHashRoute()
    await vi.waitFor(() => expect(useStore.getState().appMode).toBe('explore'))
    useStore.getState().setAppMode('image')
    expect(window.location.hash).toBe('')
  })
})
