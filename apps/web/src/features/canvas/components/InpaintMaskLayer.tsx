import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useTranslation } from '../../../i18n'
import { calculateMaskWorkingSize } from '../../../lib/maskPreprocess'
import { useInpaintSession } from '../inpaintStore'
import type { CanvasEditor } from '../lib/editor'
import { canvasImageDimensions } from '../lib/imageInfo'
import { type MaskStroke, pageToMaskPixel, renderMask } from '../lib/inpaintMask'

const SELECTION_COLOR = 'rgba(21, 156, 246, 0.34)'

/**
 * 局部重绘的就地涂抹层：盖在被选中那张图上，收走指针自己画，其余画布照常缩放平移。
 *
 * 笔画存在 `useInpaintSession` 里而不是 CanvasDoc 里——doc 的快照就是 undo 栈，
 * 把涂抹中间态写进去，一次 ⌘Z 会把用户正在画的东西撤掉，它也不该随画布持久化。
 */
export default function InpaintMaskLayer({ editor }: { editor: CanvasEditor }) {
  const { t } = useTranslation('canvas')
  useSyncExternalStore(editor.doc.subscribe, () => editor.doc.version)
  const imageId = useInpaintSession((state) => state.imageId)
  const strokes = useInpaintSession((state) => state.strokes)
  const selectedStroke = useInpaintSession((state) => state.selectedStroke)
  const selectStroke = useInpaintSession((state) => state.selectStroke)
  const kind = useInpaintSession((state) => state.kind)
  const tool = useInpaintSession((state) => state.tool)
  const brushPx = useInpaintSession((state) => state.brushPx)
  const addStroke = useInpaintSession((state) => state.addStroke)
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // 落笔中的那一笔走 ref + state 两份：ref 给事件处理器读最新值，state 只为触发重绘。
  const drawingRef = useRef<MaskStroke | null>(null)
  const [live, setLive] = useState<MaskStroke | null>(null)
  const [ring, setRing] = useState<{ x: number; y: number } | null>(null)

  const element = imageId ? editor.getElement(imageId) : undefined
  const image = element?.type === 'image' ? element : null
  const dimensions = image ? canvasImageDimensions(image, editor.doc) : null
  const size = dimensions ? calculateMaskWorkingSize(dimensions.width, dimensions.height) : null
  const maskWidth = size?.width ?? 0
  const maskHeight = size?.height ?? 0

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !image || !maskWidth || !maskHeight) return
    renderMask(canvas, image, live ? [...strokes, live] : strokes, {
      inverted: true,
      color: SELECTION_COLOR,
    })
  }, [image, maskWidth, maskHeight, strokes, live])

  if (!image || !size) return null
  const { camera } = editor.doc

  const pagePoint = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return null
    return {
      x: camera.x + (event.clientX - rect.left) / camera.zoom,
      y: camera.y + (event.clientY - rect.top) / camera.zoom,
    }
  }

  const commit = () => {
    const current = drawingRef.current
    drawingRef.current = null
    setLive(null)
    if (current?.points.length) addStroke(current)
  }

  return (
    <div ref={containerRef} className="pointer-events-none absolute inset-0 z-30 overflow-hidden">
      <div
        role="application"
        aria-label={t('inpaint.canvasAria')}
        className="absolute outline outline-2 outline-offset-2 outline-primary"
        style={{
          left: (image.x - camera.x) * camera.zoom,
          top: (image.y - camera.y) * camera.zoom,
          width: image.width * camera.zoom,
          height: image.height * camera.zoom,
          // Konva 的 rotation 绕元素左上角，这里的 transformOrigin 必须与它一致。
          transform: `rotate(${image.rotation}deg)`,
          transformOrigin: '0 0',
          pointerEvents: 'auto',
          cursor: 'crosshair',
          touchAction: 'none',
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          const point = pagePoint(event)
          if (!point) return
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          // 笔宽按落笔那一刻的相机折算成页面单位：手感跟屏幕走，数据跟图走。
          const stroke: MaskStroke =
            tool === 'rect'
              ? { tool: 'brush', shape: 'rect', points: [point, point], width: 0 }
              : { tool, points: [point], width: brushPx / camera.zoom }
          drawingRef.current = stroke
          setLive(stroke)
        }}
        onPointerMove={(event) => {
          setRing({ x: event.clientX, y: event.clientY })
          const current = drawingRef.current
          if (!current) return
          const point = pagePoint(event)
          if (!point) return
          const next = {
            ...current,
            points:
              current.shape === 'rect' ? [current.points[0]!, point] : [...current.points, point],
          }
          drawingRef.current = next
          setLive(next)
        }}
        onPointerUp={(event) => {
          const current = drawingRef.current
          const point = pagePoint(event)
          if (current && point) {
            const last = current.points[current.points.length - 1]
            drawingRef.current = {
              ...current,
              points:
                current.shape === 'rect'
                  ? [current.points[0]!, point]
                  : last?.x === point.x && last.y === point.y
                    ? current.points
                    : [...current.points, point],
            }
          }
          const completed = drawingRef.current
          if (completed?.shape === 'rect' && image) {
            const displaySize = { width: image.width, height: image.height }
            const start = pageToMaskPixel(image, displaySize, completed.points[0]!)
            const end = pageToMaskPixel(image, displaySize, completed.points[1]!)
            if (
              Math.abs(start.x - end.x) * camera.zoom < 4 ||
              Math.abs(start.y - end.y) * camera.zoom < 4
            ) {
              drawingRef.current = null
            }
          }
          commit()
        }}
        onPointerCancel={() => {
          drawingRef.current = null
          setLive(null)
        }}
        onPointerLeave={() => setRing(null)}
        // 空格、方向键、Delete 在画布上是平移 / 移动 / 删除，涂抹时不该漏过去。
        onKeyDown={(event) => event.stopPropagation()}
      >
        <canvas
          ref={canvasRef}
          width={size.width}
          height={size.height}
          className="block h-full w-full"
        />
        {kind === 'inpaint' &&
          strokes.map((stroke, index) => {
            const first = stroke.points[0]
            if (!first) return null
            const displaySize = { width: image.width, height: image.height }
            const start = pageToMaskPixel(image, displaySize, first)
            const end =
              stroke.shape === 'rect' && stroke.points[1]
                ? pageToMaskPixel(image, displaySize, stroke.points[1])
                : null
            const left = end ? Math.min(start.x, end.x) : start.x
            const top = end ? Math.min(start.y, end.y) : start.y
            return (
              <div
                key={`${index}-${first.x}-${first.y}`}
                className="pointer-events-none absolute border-2"
                style={{
                  left: left * camera.zoom,
                  top: top * camera.zoom,
                  width: end ? Math.abs(start.x - end.x) * camera.zoom : 0,
                  height: end ? Math.abs(start.y - end.y) * camera.zoom : 0,
                  borderColor: end ? '#159cf6' : 'transparent',
                  boxShadow: end && selectedStroke === index ? '0 0 0 2px #d5f3ff80' : undefined,
                }}
              >
                <button
                  type="button"
                  aria-label={t('inpaint.regionName', { no: index + 1 })}
                  aria-pressed={selectedStroke === index}
                  className="pointer-events-auto absolute -left-3 -top-3 grid h-6 w-6 place-items-center rounded-full border-2 border-white bg-[#159cf6] text-xs font-semibold text-white shadow-md"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => selectStroke(index)}
                >
                  {index + 1}
                </button>
              </div>
            )
          })}
      </div>
      {ring && tool !== 'rect' && (
        <span
          aria-hidden="true"
          className={`pointer-events-none fixed rounded-full border-2 ${kind === 'inpaint' ? 'border-[#159cf6]/80' : 'border-primary/80'}`}
          style={{
            left: ring.x - brushPx / 2,
            top: ring.y - brushPx / 2,
            width: brushPx,
            height: brushPx,
          }}
        />
      )}
    </div>
  )
}
