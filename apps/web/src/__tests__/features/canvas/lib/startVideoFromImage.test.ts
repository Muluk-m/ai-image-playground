// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const cached = vi.hoisted(() => ({ value: 'data:image/png;base64,AAAA' as string | null }))

vi.mock('../../../../store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../store')>()),
  ensureImageCached: async () => cached.value,
}))

import { startVideoFromImage } from '../../../../features/canvas/lib/startVideoFromImage'
import { useLibraryStore } from '../../../../features/library/store'
import { useStore } from '../../../../store'

beforeEach(() => {
  cached.value = 'data:image/png;base64,AAAA'
  useLibraryStore.setState({ panelOpen: true })
  useStore.setState({
    appMode: 'browse',
    pendingCanvasImages: [],
    lightboxImageId: 'img-1',
    detailTaskId: 'task-1',
    showToast: vi.fn(),
  })
})

describe('从一张图发起生成视频', () => {
  it('切到视频入口并把图放上画布，浮层一起关', async () => {
    await startVideoFromImage('img-1')

    const main = useStore.getState()
    expect(main.appMode).toBe('video')
    expect(main.pendingCanvasImages).toEqual(['data:image/png;base64,AAAA'])
    expect(main.lightboxImageId).toBeNull()
    expect(main.detailTaskId).toBeNull()
    expect(useLibraryStore.getState().panelOpen).toBe(false)
  })

  it('从创作入口发起也进视频入口：生成什么由入口决定', async () => {
    useStore.setState({ appMode: 'create' })

    await startVideoFromImage('img-1')

    expect(useStore.getState().appMode).toBe('video')
    expect(useStore.getState().pendingCanvasImages).toHaveLength(1)
  })

  it('图已经不在本机时提示，不切入口也不放图', async () => {
    cached.value = null

    await startVideoFromImage('img-1')

    expect(useStore.getState().appMode).toBe('browse')
    expect(useStore.getState().lightboxImageId).toBe('img-1')
    expect(useLibraryStore.getState().panelOpen).toBe(true)
    expect(useStore.getState().pendingCanvasImages).toEqual([])
    expect(useStore.getState().showToast).toHaveBeenCalledWith(expect.any(String), 'error')
  })
})
