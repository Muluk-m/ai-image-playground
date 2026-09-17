import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { useTranslation } from '../../../i18n'
import { subscribeTheme } from '../../../theme'
import type { CanvasEl } from '../lib/canvasDoc'
import type { CanvasEditor } from '../lib/editor'
import type { Box } from '../lib/geometry'
import {
  cameraForCenter,
  computeMinimapProjection,
  isInsideBox,
  MINIMAP_HEIGHT,
  MINIMAP_WIDTH,
  type MinimapProjection,
  type MinimapRect,
  minimapPointToPage,
  minimapRects,
  minimapSourceBox,
  projectBox,
  rectsBounds,
} from '../lib/minimap'

/** 最小可见块：一张缩到亚像素的图还是要看得见。 */
const MIN_RECT_PX = 2

function paint(
  ctx: CanvasRenderingContext2D,
  proj: MinimapProjection,
  rects: readonly MinimapRect[],
  viewport: Box,
  viewportColor: string,
): void {
  ctx.clearRect(0, 0, MINIMAP_WIDTH, MINIMAP_HEIGHT)
  for (const rect of rects) {
    const p = projectBox(proj, rect)
    const w = Math.max(MIN_RECT_PX, p.w)
    const h = Math.max(MIN_RECT_PX, p.h)
    if (rect.style === 'dash') {
      ctx.strokeStyle = rect.color
      ctx.lineWidth = 1
      ctx.setLineDash([2, 2])
      ctx.strokeRect(p.x + 0.5, p.y + 0.5, Math.max(1, w - 1), Math.max(1, h - 1))
      ctx.setLineDash([])
    } else {
      ctx.fillStyle = rect.color
      ctx.fillRect(p.x, p.y, w, h)
    }
  }
  const vp = projectBox(proj, viewport)
  ctx.strokeStyle = viewportColor
  ctx.lineWidth = 1.5
  ctx.strokeRect(vp.x, vp.y, Math.max(3, vp.w), Math.max(3, vp.h))
}

interface RectCache {
  elements: readonly CanvasEl[] | null
  rects: MinimapRect[]
  bounds: Box | null
}

/**
 * 右下角小地图：元素画成小块，当前视口是一圈亮框，点或拖就能把镜头挪过去（缩放不动）。
 *
 * 重绘走 imperative canvas，不走 React：拖画布时 doc 每帧 emit，若每帧都过一遍 React
 * 渲染，元素一多就掉帧。这里只在「空 ↔ 非空」翻转时让 React 重渲染，其余变更由订阅
 * 回调合并进一次 rAF 里直接画；元素块按元素数组的引用缓存，只动 camera 的高频路径
 * 一个包围盒都不用重算。
 */
export default function CanvasMinimap({ editor }: { editor: CanvasEditor }) {
  const { t } = useTranslation('canvas')
  const { doc } = editor
  const hasContent = useSyncExternalStore(doc.subscribe, () => doc.elements.length > 0)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const cacheRef = useRef<RectCache>({ elements: null, rects: [], bounds: null })
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)

  /** 当前该画什么 / 点在哪：重绘与命中判定共用一份，投影不会比画面旧一帧。 */
  const currentFrame = useCallback(() => {
    const cache = cacheRef.current
    if (cache.elements !== doc.elements) {
      const rects = minimapRects(doc.elements)
      cacheRef.current = { elements: doc.elements, rects, bounds: rectsBounds(rects) }
    }
    const { rects, bounds } = cacheRef.current
    const viewport = editor.getViewportPageBounds()
    return { rects, viewport, proj: computeMinimapProjection(minimapSourceBox(bounds, viewport)) }
  }, [doc, editor])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!hasContent || !canvas) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.round(MINIMAP_WIDTH * dpr)
    canvas.height = Math.round(MINIMAP_HEIGHT * dpr)
    let ctx: CanvasRenderingContext2D | null = null
    try {
      ctx = canvas.getContext('2d')
      ctx?.scale(dpr, dpr)
    } catch {
      return // 没有 2D 上下文（测试环境等）：画不了就别挂订阅，跳转仍然可用
    }
    if (!ctx) return
    const target = ctx

    let frame = 0
    const draw = () => {
      frame = 0
      const { proj, rects, viewport } = currentFrame()
      paint(target, proj, rects, viewport, getComputedStyle(canvas).color)
    }

    draw()
    // 颜色取自 CSS 变量，主题一换（无论是系统变了还是用户翻转）就得重画。
    const unsubscribeTheme = subscribeTheme(draw)
    const unsubscribe = doc.subscribe(() => {
      if (!frame) frame = requestAnimationFrame(draw)
    })
    return () => {
      unsubscribe()
      unsubscribeTheme()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [doc, currentFrame, hasContent])

  if (!hasContent) return null

  const pagePointOf = (event: React.PointerEvent<HTMLCanvasElement>, proj: MinimapProjection) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return minimapPointToPage(proj, event.clientX - rect.left, event.clientY - rect.top)
  }

  const centerOn = (point: { x: number; y: number }) => {
    doc.setCamera(cameraForCenter(point, doc.viewport, doc.camera.zoom))
  }

  return (
    <div className="pointer-events-auto overflow-hidden rounded-xl border border-border bg-sidebar shadow-lg backdrop-blur">
      <canvas
        ref={canvasRef}
        style={{ width: MINIMAP_WIDTH, height: MINIMAP_HEIGHT }}
        className="block cursor-pointer touch-none"
        aria-label={t('minimap.label')}
        onPointerDown={(event) => {
          const { proj, viewport } = currentFrame()
          const point = pagePointOf(event, proj)
          if (isInsideBox(viewport, point)) {
            // 抓住视口框：记住抓点相对中心的偏移，拖起来不会跳
            dragRef.current = { dx: point.x - viewport.midX, dy: point.y - viewport.midY }
          } else {
            dragRef.current = { dx: 0, dy: 0 }
            centerOn(point)
          }
          try {
            event.currentTarget.setPointerCapture(event.pointerId)
          } catch {
            // 无指针捕获（测试环境等）：拖出小地图就跟丢，点击跳转不受影响
          }
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current
          if (!drag) return
          const point = pagePointOf(event, currentFrame().proj)
          centerOn({ x: point.x - drag.dx, y: point.y - drag.dy })
        }}
        onPointerUp={() => {
          dragRef.current = null
        }}
        onPointerCancel={() => {
          dragRef.current = null
        }}
      />
    </div>
  )
}
