import { VIDEO_MODEL_SUPPORT, type VideoModelSupport } from '@image-playground/shared'
import { describe, expect, it } from 'vitest'
import { planVideoFrames } from '../../../../features/canvas/lib/canvasVideoPlan'
import { Box } from '../../../../features/canvas/lib/geometry'

const BOTH: VideoModelSupport = {
  ...Object.values(VIDEO_MODEL_SUPPORT)[0]!,
  firstFrame: true,
  lastFrame: true,
}
const FIRST_ONLY: VideoModelSupport = { ...BOTH, lastFrame: false }
const TEXT_ONLY: VideoModelSupport = { ...BOTH, firstFrame: false, lastFrame: false }

function image(id: string, x: number, video = false) {
  return { entry: { imageId: id, box: new Box(x, 0, 100, 100), graphicIds: [] }, video }
}

describe('画布视频档的选区语义', () => {
  it('generates from text when nothing is selected', () => {
    expect(planVideoFrames([], BOTH)).toEqual({ ok: true, frames: [] })
  })

  it('uses one selected image as the first frame', () => {
    const plan = planVideoFrames([image('a', 0)], BOTH)
    expect(plan.ok && plan.frames.map((one) => one.imageId)).toEqual(['a'])
  })

  it('orders two images left to right as first and last frame, whatever the selection order', () => {
    const plan = planVideoFrames([image('right', 500), image('left', 0)], BOTH)
    expect(plan.ok && plan.frames.map((one) => one.imageId)).toEqual(['left', 'right'])
  })

  it('refuses a second image when the model has no last frame instead of dropping it', () => {
    expect(planVideoFrames([image('a', 0), image('b', 200)], FIRST_ONLY)).toEqual({
      ok: false,
      reason: 'lastFrameUnsupported',
    })
  })

  it('refuses images when the model cannot start from one', () => {
    expect(planVideoFrames([image('a', 0)], TEXT_ONLY)).toEqual({
      ok: false,
      reason: 'firstFrameUnsupported',
    })
  })

  it('refuses more than two images', () => {
    expect(planVideoFrames([image('a', 0), image('b', 1), image('c', 2)], BOTH)).toEqual({
      ok: false,
      reason: 'tooManyImages',
    })
  })

  it('sends a selected video to its own toolbar rather than using its poster as a frame', () => {
    expect(planVideoFrames([image('clip', 0, true)], BOTH)).toEqual({
      ok: false,
      reason: 'videoSelected',
    })
  })
})
