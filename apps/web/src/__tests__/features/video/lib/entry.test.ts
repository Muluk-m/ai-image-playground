import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useLibraryStore } from '../../../../features/library/store'
import { startVideoFromImage } from '../../../../features/video/lib/entry'
import { INITIAL_VIDEO_DRAFT, useVideoStore } from '../../../../features/video/store'
import { useStore } from '../../../../store'

beforeEach(() => {
  useVideoStore.setState({ draft: { ...INITIAL_VIDEO_DRAFT } })
  useStore.setState({ appMode: 'browse', lightboxImageId: 'img-1', detailTaskId: 'task-1' })
  useLibraryStore.setState({ panelOpen: true })
})

describe('做成视频 from the image side', () => {
  it('fills the first frame and lands on the video composer', () => {
    startVideoFromImage('img-1')

    expect(useVideoStore.getState().draft).toMatchObject({
      source: 'image',
      firstFrameImageId: 'img-1',
    })
    expect(useStore.getState().appMode).toBe('video')
    expect(useStore.getState().lightboxImageId).toBeNull()
    expect(useStore.getState().detailTaskId).toBeNull()
    expect(useLibraryStore.getState().panelOpen).toBe(false)
  })
})
