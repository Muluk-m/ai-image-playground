// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CanvasMinimap from '../../../../features/canvas/components/CanvasMinimap'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import {
  computeMinimapProjection,
  minimapRects,
  minimapSourceBox,
  projectBox,
  rectsBounds,
} from '../../../../features/canvas/lib/minimap'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const VIEWPORT = { width: 800, height: 600 }

/** jsdom 没有 2D 上下文：记录画了什么的假 ctx，顺便把 paint 的坐标拿出来断言。 */
interface DrawCall {
  op: 'clear' | 'fill' | 'stroke'
  args: number[]
  color: string
}

function createFakeContext(): { calls: DrawCall[] } & Record<string, unknown> {
  const calls: DrawCall[] = []
  return {
    calls,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    scale() {},
    setLineDash() {},
    clearRect(...args: number[]) {
      calls.push({ op: 'clear', args, color: '' })
    },
    fillRect(this: { fillStyle: string }, ...args: number[]) {
      calls.push({ op: 'fill', args, color: this.fillStyle })
    },
    strokeRect(this: { strokeStyle: string }, ...args: number[]) {
      calls.push({ op: 'stroke', args, color: this.strokeStyle })
    },
  }
}

let host: HTMLDivElement
let root: Root
let doc: CanvasDoc
let editor: CanvasEditor
let ctx: ReturnType<typeof createFakeContext>

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  doc = new CanvasDoc()
  doc.setViewport(VIEWPORT.width, VIEWPORT.height)
  editor = new CanvasEditor(doc)
  ctx = createFakeContext()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => ctx as unknown as CanvasRenderingContext2D,
  )
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

function render(): void {
  act(() => {
    root.render(<CanvasMinimap editor={editor} />)
  })
}

function addImage(x: number, y: number, size = 400): void {
  editor.placeImages([{ dataUrl: 'data:image/png;base64,AQID', x, y, width: size, height: size }])
}

function canvasEl(): HTMLCanvasElement | null {
  return host.querySelector('canvas')
}

/** 小地图里某个页面点的坐标：组件用的是同一套投影（jsdom 下 getBoundingClientRect 全 0）。 */
function minimapPointOf(page: { x: number; y: number }): { x: number; y: number } {
  const viewport = editor.getViewportPageBounds()
  const proj = computeMinimapProjection(
    minimapSourceBox(rectsBounds(minimapRects(doc.elements)), viewport),
  )
  const p = projectBox(proj, { x: page.x, y: page.y, w: 0, h: 0 })
  return { x: p.x, y: p.y }
}

function pointer(type: string, x: number, y: number): void {
  const target = canvasEl()
  if (!target) throw new Error('小地图未渲染')
  act(() => {
    target.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }),
    )
  })
}

describe('CanvasMinimap', () => {
  it('画布为空时不渲染', () => {
    render()
    expect(canvasEl()).toBeNull()
  })

  it('画布非空时渲染小地图，清空后又收起', () => {
    addImage(0, 0)
    render()
    expect(canvasEl()).not.toBeNull()

    act(() => doc.deleteElements(doc.elements.map((el) => el.id)))
    expect(canvasEl()).toBeNull()
  })

  it('每个元素画一块，视口画成一圈框，位置与投影一致', () => {
    addImage(2000, 2000)
    render()

    const viewport = editor.getViewportPageBounds()
    const expected = (() => {
      const proj = computeMinimapProjection(
        minimapSourceBox(rectsBounds(minimapRects(doc.elements)), viewport),
      )
      return {
        element: projectBox(proj, { x: 2000, y: 2000, w: 400, h: 400 }),
        viewport: projectBox(proj, viewport),
      }
    })()

    const fills = ctx.calls.filter((call) => call.op === 'fill')
    const strokes = ctx.calls.filter((call) => call.op === 'stroke')
    expect(fills).toHaveLength(1)
    expect(fills[0].args[0]).toBeCloseTo(expected.element.x, 6)
    expect(fills[0].args[1]).toBeCloseTo(expected.element.y, 6)
    // 视口框是最后画的那一笔（压在元素之上）
    expect(strokes).toHaveLength(1)
    expect(strokes[0].args[0]).toBeCloseTo(expected.viewport.x, 6)
    expect(strokes[0].args[2]).toBeCloseTo(expected.viewport.w, 6)
  })

  it('点小地图空白处：视口中心移到那一点，缩放不变', () => {
    addImage(2000, 2000)
    render()

    const target = { x: 2200, y: 2200 }
    const click = minimapPointOf(target)
    pointer('pointerdown', click.x, click.y)

    expect(doc.camera.zoom).toBe(1)
    expect(doc.camera.x).toBeCloseTo(target.x - VIEWPORT.width / 2, 6)
    expect(doc.camera.y).toBeCloseTo(target.y - VIEWPORT.height / 2, 6)
  })

  it('按住视口框拖动：镜头跟着走，不跳到按下的点', () => {
    addImage(2000, 2000)
    render()

    // 视口是 (0,0,800,600)，按在它内部靠左上的位置
    const grab = minimapPointOf({ x: 100, y: 100 })
    pointer('pointerdown', grab.x, grab.y)
    // 抓的是视口框本身：按下不该挪镜头
    expect(doc.camera).toMatchObject({ x: 0, y: 0, zoom: 1 })

    const moved = minimapPointOf({ x: 500, y: 300 })
    pointer('pointermove', moved.x, moved.y)

    // 抓点偏移保留 → 镜头位移等于指针在页面坐标里的位移
    expect(doc.camera.x).toBeCloseTo(400, 6)
    expect(doc.camera.y).toBeCloseTo(200, 6)
    expect(doc.camera.zoom).toBe(1)

    // 松手后再移动不再改镜头
    pointer('pointerup', moved.x, moved.y)
    pointer('pointermove', grab.x, grab.y)
    expect(doc.camera.x).toBeCloseTo(400, 6)
  })

  it('一帧内的连续变更只安排一次重绘', () => {
    addImage(0, 0)
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame').mockReturnValue(1 as never)
    render()
    raf.mockClear()

    // 拖画布时每帧多次 emit（camera + 元素补丁），不能一次一重绘
    act(() => {
      doc.setCamera({ x: 10 })
      doc.setCamera({ x: 20 })
      doc.setCamera({ x: 30 })
    })
    expect(raf).toHaveBeenCalledTimes(1)

    // 上一帧画完后才会再安排下一次
    act(() => raf.mock.calls[0][0](0))
    act(() => doc.setCamera({ x: 40 }))
    expect(raf).toHaveBeenCalledTimes(2)
  })
})
