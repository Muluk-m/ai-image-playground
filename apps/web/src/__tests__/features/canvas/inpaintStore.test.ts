import { beforeEach, describe, expect, it } from 'vitest'
import { useInpaintSession } from '../../../features/canvas/inpaintStore'

const rect = (x: number) => ({
  tool: 'brush' as const,
  shape: 'rect' as const,
  width: 0,
  points: [
    { x, y: 0 },
    { x: x + 10, y: 10 },
  ],
})

beforeEach(() => useInpaintSession.getState().close())

describe('smart edit regions', () => {
  it('selects the last mark and keeps selection valid when a region is removed', () => {
    const session = useInpaintSession.getState()
    session.open('image-1', 'inpaint')
    expect(useInpaintSession.getState().tool).toBe('rect')
    session.addStroke(rect(0))
    session.addStroke(rect(20))
    session.addStroke(rect(40))
    expect(useInpaintSession.getState().selectedStroke).toBe(2)
    session.removeStroke(0)
    expect(useInpaintSession.getState().selectedStroke).toBe(1)
    session.removeStroke(1)
    expect(useInpaintSession.getState().selectedStroke).toBe(0)
    expect(useInpaintSession.getState().strokes).toEqual([rect(20)])
    session.removeStroke(0)
    expect(useInpaintSession.getState().selectedStroke).toBeNull()
  })

  it('opens erase with its brush and clears marks when switching images', () => {
    const session = useInpaintSession.getState()
    session.open('image-1', 'inpaint')
    session.addStroke(rect(0))
    session.open('image-2', 'erase')
    expect(useInpaintSession.getState()).toMatchObject({
      imageId: 'image-2',
      kind: 'erase',
      tool: 'brush',
      strokes: [],
      selectedStroke: null,
    })
  })
})
