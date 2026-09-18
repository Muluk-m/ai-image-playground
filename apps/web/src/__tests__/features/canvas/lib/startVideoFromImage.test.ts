// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const cached = vi.hoisted(() => ({ value: 'data:image/png;base64,AAAA' as string | null }))
const capabilities = vi.hoisted(() => ({ agent: true }))

vi.mock('../../../../features/agent/panelLayout', () => ({
  agentPanelPresent: () => capabilities.agent,
}))

vi.mock('../../../../store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../store')>()),
  ensureImageCached: async () => cached.value,
}))

import { useCanvasComposer } from '../../../../features/canvas/composerStore'
import { startVideoFromImage } from '../../../../features/canvas/lib/startVideoFromImage'
import { useLibraryStore } from '../../../../features/library/store'
import { useStore } from '../../../../store'

beforeEach(() => {
  cached.value = 'data:image/png;base64,AAAA'
  capabilities.agent = true
  useCanvasComposer.setState({ mode: 'image', agentVideoPending: false })
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
  it('从作品页进视频入口，把图放上画布并预置视频', async () => {
    await startVideoFromImage('img-1')

    const main = useStore.getState()
    expect(main.appMode).toBe('video')
    expect(main.pendingCanvasImages).toEqual(['data:image/png;base64,AAAA'])
    expect(main.lightboxImageId).toBeNull()
    expect(main.detailTaskId).toBeNull()
    expect(useLibraryStore.getState().panelOpen).toBe(false)
    expect(useCanvasComposer.getState().mode).toBe('video')
    expect(useCanvasComposer.getState().agentVideoPending).toBe(true)
  })

  it('没有智能体的部署不留等人接手的标记，也不改记住的档位', async () => {
    capabilities.agent = false
    localStorage.removeItem('canvas.generateMode')

    await startVideoFromImage('img-1')

    expect(useCanvasComposer.getState().mode).toBe('video')
    expect(useCanvasComposer.getState().agentVideoPending).toBe(false)
    expect(localStorage.getItem('canvas.generateMode')).toBeNull()
  })

  it('已经在创作画布上就留在原入口', async () => {
    useStore.setState({ appMode: 'create' })

    await startVideoFromImage('img-1')

    expect(useStore.getState().appMode).toBe('create')
    expect(useStore.getState().pendingCanvasImages).toHaveLength(1)
    expect(useCanvasComposer.getState().mode).toBe('video')
  })

  it('图已经不在本机时提示，不切入口也不放图', async () => {
    cached.value = null

    await startVideoFromImage('img-1')

    expect(useStore.getState().appMode).toBe('browse')
    expect(useStore.getState().lightboxImageId).toBe('img-1')
    expect(useLibraryStore.getState().panelOpen).toBe(true)
    expect(useStore.getState().pendingCanvasImages).toEqual([])
    expect(useStore.getState().showToast).toHaveBeenCalledWith(expect.any(String), 'error')
    expect(useCanvasComposer.getState().mode).toBe('image')
  })
})
