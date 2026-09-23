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
import { type MaskStroke, renderMask } from '../lib/inpaintMask'

/** 涂抹高亮：半透明才看得见底下要改的东西，颜色刻意避开占位框的蓝 / 红 / 橙。 */
const SELECTION_COLOR = 'rgba(139, 92, 246, 0.55)'

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
          const stroke: MaskStroke = { tool, points: [point], width: brushPx / camera.zoom }
          drawingRef.current = stroke
          setLive(stroke)
        }}
        onPointerMove={(event) => {
          setRing({ x: event.clientX, y: event.clientY })
          const current = drawingRef.current
          if (!current) return
          const point = pagePoint(event)
          if (!point) return
          const next = { ...current, points: [...current.points, point] }
          drawingRef.current = next
          setLive(next)
        }}
        onPointerUp={commit}
        onPointerCancel={commit}
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
      </div>
      {ring && (
        <span
          aria-hidden="true"
          className="pointer-events-none fixed rounded-full border-2 border-primary/80"
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
