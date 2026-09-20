// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const cached = vi.hoisted(() => ({ value: 'data:image/png;base64,AAAA' as string | null }))
const project = vi.hoisted(() => ({ kind: 'image' as 'image' | 'video' }))
const createProject = vi.hoisted(() => vi.fn(async () => true))

vi.mock('../../../../store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../store')>()),
  ensureImageCached: async () => cached.value,
}))
vi.mock('../../../../features/canvas/projectStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../features/canvas/projectStore')>()),
  currentCanvasProject: () => ({ kind: project.kind }),
}))
vi.mock('../../../../features/agent/store', () => ({
  useAgentStore: { getState: () => ({ createProject }) },
}))

import { useCanvasComposer } from '../../../../features/canvas/composerStore'
import { startVideoFromImage } from '../../../../features/canvas/lib/startVideoFromImage'
import { useLibraryStore } from '../../../../features/library/store'
import { useStore } from '../../../../store'

beforeEach(() => {
  cached.value = 'data:image/png;base64,AAAA'
  project.kind = 'image'
  createProject.mockClear()
  useCanvasComposer.setState({ mode: 'image' })
  useLibraryStore.setState({ onLibraryPage: true })
  useStore.setState({
    appMode: 'image',
    pendingCanvasImages: [],
    lightboxImageId: 'img-1',
    detailTaskId: 'task-1',
    showToast: vi.fn(),
  })
})

describe('从一张图发起生成视频', () => {
  it('图片画布里发起视频：自动开一张视频画布，再把图带过去', async () => {
    await startVideoFromImage('img-1')

    const main = useStore.getState()
    expect(createProject).toHaveBeenCalledWith('video')
    expect(main.appMode).toBe('canvas')
    expect(main.pendingCanvasImages).toEqual(['data:image/png;base64,AAAA'])
    expect(main.lightboxImageId).toBeNull()
    expect(main.detailTaskId).toBeNull()
    expect(useLibraryStore.getState().onLibraryPage).toBe(false)
    expect(useCanvasComposer.getState().mode).toBe('video')
  })

  it('预置不算用户的选择，不改记住的档位', async () => {
    localStorage.removeItem('canvas.generateMode')

    await startVideoFromImage('img-1')

    expect(useCanvasComposer.getState().mode).toBe('video')
    expect(localStorage.getItem('canvas.generateMode')).toBeNull()
  })

  it('已经在视频画布上就留在原处，不再开新的', async () => {
    project.kind = 'video'
    useStore.setState({ appMode: 'canvas' })

    await startVideoFromImage('img-1')

    expect(createProject).not.toHaveBeenCalled()
    expect(useStore.getState().appMode).toBe('canvas')
    expect(useStore.getState().pendingCanvasImages).toHaveLength(1)
    expect(useCanvasComposer.getState().mode).toBe('video')
  })

  it('新画布开不出来就不带图走', async () => {
    createProject.mockResolvedValueOnce(false)

    await startVideoFromImage('img-1')

    expect(useStore.getState().appMode).toBe('image')
    expect(useStore.getState().pendingCanvasImages).toEqual([])
  })

  it('图已经不在本机时提示，不切入口也不放图', async () => {
    cached.value = null

    await startVideoFromImage('img-1')

    expect(useStore.getState().appMode).toBe('image')
    expect(useStore.getState().lightboxImageId).toBe('img-1')
    expect(useLibraryStore.getState().onLibraryPage).toBe(true)
    expect(useStore.getState().pendingCanvasImages).toEqual([])
    expect(useStore.getState().showToast).toHaveBeenCalledWith(expect.any(String), 'error')
    expect(useCanvasComposer.getState().mode).toBe('image')
  })
})
