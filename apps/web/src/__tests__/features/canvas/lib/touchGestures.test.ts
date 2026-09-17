// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CanvasDoc, ZOOM_MAX } from '../../../../features/canvas/lib/canvasDoc'
import { bindCanvasTouch, touchCamera } from '../../../../features/canvas/lib/touchGestures'

let doc: CanvasDoc
let container: HTMLDivElement
let cleanup: () => void
let hit: ReturnType<typeof vi.fn<() => string | undefined>>
let menu: ReturnType<typeof vi.fn<() => void>>
let interrupt: ReturnType<typeof vi.fn<() => void>>
let active: ReturnType<typeof vi.fn<() => void>>
function touch(type: string, points: number[][]) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'touches', {
    value: points.map(([x, y], id) => ({ identifier: id, clientX: x, clientY: y })),
  })
  container.dispatchEvent(event)
  return event
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 16))
  vi.stubGlobal('cancelAnimationFrame', clearTimeout)
  doc = new CanvasDoc()
  doc.restore(
    [
      {
        id: 'image',
        type: 'image',
        x: 20,
        y: 30,
        width: 100,
        height: 100,
        rotation: 0,
        fileId: 'file',
      },
    ],
    {},
  )
  container = document.createElement('div')
  document.body.append(container)
  hit = vi.fn(() => undefined)
  menu = vi.fn()
  interrupt = vi.fn()
  active = vi.fn()
  cleanup = bindCanvasTouch(container, doc, { hit, menu, interrupt, active })
})
afterEach(() => {
  cleanup()
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('canvas touch navigation', () => {
  it('moves content with the finger and combines rapid moves into a single frame', () => {
    const notify = vi.fn()
    doc.subscribe(notify)
    expect(touch('touchstart', [[100, 100]]).defaultPrevented).toBe(true)
    touch('touchmove', [[100, 120]])
    touch('touchmove', [[100, 160]])
    expect(notify).not.toHaveBeenCalled()
    vi.advanceTimersByTime(16)
    expect(doc.camera.y).toBe(-60)
    expect(notify).toHaveBeenCalledTimes(1)
    touch('touchend', [])
    touch('touchstart', [[100, 100]])
    touch('touchmove', [[100, 60]])
    touch('touchend', [])
    expect(doc.camera.y).toBe(-20)
  })
  it('pinches and translates around the touch midpoint, then continues without a jump', () => {
    touch('touchstart', [
      [100, 100],
      [200, 100],
    ])
    touch('touchmove', [
      [80, 120],
      [280, 120],
    ])
    vi.advanceTimersByTime(16)
    expect(doc.camera).toEqual({ x: 60, y: 40, zoom: 2 })
    touch('touchend', [[80, 120]])
    touch('touchmove', [[100, 140]])
    touch('touchend', [])
    expect(doc.camera).toEqual({ x: 50, y: 30, zoom: 2 })
    expect(interrupt).toHaveBeenCalledOnce()
  })
  it('clamps zoom while preserving the original anchor', () => {
    expect(
      touchCamera({ x: 0, y: 0, zoom: 1 }, { x: 100, y: 100 }, { x: 200, y: 200 }, 100),
    ).toEqual({ x: 100 - 200 / ZOOM_MAX, y: 100 - 200 / ZOOM_MAX, zoom: ZOOM_MAX })
  })
  it('selects on tap, drags selected objects with one undo, and pans over unselected images', () => {
    hit.mockReturnValue('image')
    touch('touchstart', [[30, 40]])
    touch('touchmove', [[50, 60]])
    touch('touchend', [])
    expect(doc.getElement('image')).toMatchObject({ x: 20, y: 30 })
    touch('touchstart', [[30, 40]])
    touch('touchend', [])
    expect([...doc.selection]).toEqual(['image'])
    touch('touchstart', [[30, 40]])
    touch('touchmove', [[50, 70]])
    touch('touchend', [])
    expect(doc.getElement('image')).toMatchObject({ x: 40, y: 60 })
    doc.undo()
    expect(doc.getElement('image')).toMatchObject({ x: 20, y: 30 })
  })
  it('opens image actions after holding, cancels on motion or second contact, and cleans timers', () => {
    hit.mockReturnValue('image')
    touch('touchstart', [[30, 40]])
    vi.advanceTimersByTime(500)
    expect(menu).toHaveBeenCalledWith('image', { x: 30, y: 40 })
    touch('touchend', [])
    menu.mockClear()
    touch('touchstart', [[30, 40]])
    touch('touchmove', [[30, 60]])
    vi.advanceTimersByTime(600)
    expect(menu).not.toHaveBeenCalled()
    touch('touchend', [])
    touch('touchstart', [[30, 40]])
    touch('touchstart', [
      [30, 40],
      [80, 90],
    ])
    vi.advanceTimersByTime(600)
    expect(menu).not.toHaveBeenCalled()
    touch('touchcancel', [])
    touch('touchstart', [[30, 40]])
    cleanup()
    vi.advanceTimersByTime(600)
    expect(menu).not.toHaveBeenCalled()
  })
  it('cancels without selecting and allows the next gesture to start fresh', () => {
    hit.mockReturnValue('image')
    touch('touchstart', [[30, 40]])
    touch('touchcancel', [])
    expect(doc.selection.size).toBe(0)
    expect(active).toHaveBeenLastCalledWith(false)
    touch('touchstart', [[30, 40]])
    touch('touchend', [])
    expect(doc.selection.has('image')).toBe(true)
  })
  it('leaves transform handles to Konva until another finger takes over', () => {
    cleanup()
    cleanup = bindCanvasTouch(container, doc, { hit, menu, interrupt, active, native: () => true })
    expect(touch('touchstart', [[30, 40]]).defaultPrevented).toBe(false)
    expect(touch('touchmove', [[60, 70]]).defaultPrevented).toBe(false)
    expect(
      touch('touchstart', [
        [60, 70],
        [100, 100],
      ]).defaultPrevented,
    ).toBe(true)
    expect(interrupt).toHaveBeenCalledOnce()
    touch('touchend', [])
  })

  it('keeps drawing single-touch events available but owns pinch until all fingers lift', () => {
    doc.setTool('pen')
    expect(touch('touchstart', [[30, 40]]).defaultPrevented).toBe(false)
    expect(
      touch('touchstart', [
        [30, 40],
        [80, 90],
      ]).defaultPrevented,
    ).toBe(true)
    touch('touchend', [[30, 40]])
    expect(touch('touchmove', [[30, 80]]).defaultPrevented).toBe(true)
    touch('touchend', [])
    expect(touch('touchstart', [[30, 40]]).defaultPrevented).toBe(false)
  })
})
