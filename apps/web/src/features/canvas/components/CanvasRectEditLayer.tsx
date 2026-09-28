import { type PointerEvent as ReactPointerEvent, useRef, useSyncExternalStore } from 'react'
import { useTranslation } from '../../../i18n'
import type { CanvasEditor } from '../lib/editor'
import {
  applyHandleDrag,
  localToPage,
  pageDeltaToLocal,
  type RectHandle,
} from '../lib/imageRectEdit'
import { useRectEdit } from '../rectEditStore'

const HANDLES: readonly RectHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

/** 手柄在框上的相对位置（百分比），与手柄名一一对应。 */
const HANDLE_POSITION: Record<RectHandle, { left: string; top: string; cursor: string }> = {
  nw: { left: '0%', top: '0%', cursor: 'nwse-resize' },
  n: { left: '50%', top: '0%', cursor: 'ns-resize' },
  ne: { left: '100%', top: '0%', cursor: 'nesw-resize' },
  e: { left: '100%', top: '50%', cursor: 'ew-resize' },
  se: { left: '100%', top: '100%', cursor: 'nwse-resize' },
  s: { left: '50%', top: '100%', cursor: 'ns-resize' },
  sw: { left: '0%', top: '100%', cursor: 'nesw-resize' },
  w: { left: '0%', top: '50%', cursor: 'ew-resize' },
}

/**
 * 裁切与扩图共用的拖拽框。它只收集视觉区域，确认与 Agent 请求在图片快捷菜单中完成。
 *
 * 框存在 `useRectEdit` 里不进 CanvasDoc：doc 的快照就是 undo 栈，
 * 把拖动中间态写进去，一次 ⌘Z 只会撤掉上一帧拖动。
 */
export default function CanvasRectEditLayer({ editor }: { editor: CanvasEditor }) {
  const { t } = useTranslation('canvas')
  useSyncExternalStore(editor.doc.subscribe, () => editor.doc.version)
  const session = useRectEdit()
  const dragRef = useRef<{
    handle: RectHandle
    startX: number
    startY: number
    base: typeof session.rect
  } | null>(null)

  const element = session.imageId ? editor.getElement(session.imageId) : undefined
  const image = element?.type === 'image' ? element : null
  if (!session.mode || !image) return null

  const { camera } = editor.doc
  const origin = localToPage(image, { x: session.rect.x, y: session.rect.y })
  const outpaint = session.mode === 'outpaint'

  const onHandleDown = (handle: RectHandle) => (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      handle,
      startX: event.clientX,
      startY: event.clientY,
      base: session.rect,
    }
  }

  const onHandleMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    const pageDelta = {
      x: (event.clientX - drag.startX) / camera.zoom,
      y: (event.clientY - drag.startY) / camera.zoom,
    }
    session.setRect(
      applyHandleDrag(
        session.mode!,
        drag.base,
        drag.handle,
        pageDeltaToLocal(image, pageDelta),
        image,
      ),
    )
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-30 overflow-hidden">
      {/* 裁切时把框外压暗：9999px 的外扩阴影被图片自身的裁剪容器切住，正好只暗到图边。 */}
      {!outpaint && (
        <div
          className="absolute overflow-hidden"
          style={{
            left: (image.x - camera.x) * camera.zoom,
            top: (image.y - camera.y) * camera.zoom,
            width: image.width * camera.zoom,
            height: image.height * camera.zoom,
            transform: `rotate(${image.rotation}deg)`,
            transformOrigin: '0 0',
          }}
        >
          <div
            className="absolute"
            style={{
              left: session.rect.x * camera.zoom,
              top: session.rect.y * camera.zoom,
              width: session.rect.w * camera.zoom,
              height: session.rect.h * camera.zoom,
              boxShadow: '0 0 0 9999px rgba(0,0,0,0.5)',
            }}
          />
        </div>
      )}

      <div
        className={`absolute border-2 border-dashed border-primary ${outpaint ? 'bg-primary/15' : ''}`}
        style={{
          left: (origin.x - camera.x) * camera.zoom,
          top: (origin.y - camera.y) * camera.zoom,
          width: session.rect.w * camera.zoom,
          height: session.rect.h * camera.zoom,
          transform: `rotate(${image.rotation}deg)`,
          transformOrigin: '0 0',
        }}
      >
        {HANDLES.map((handle) => {
          const spot = HANDLE_POSITION[handle]
          return (
            <div
              key={handle}
              role="slider"
              tabIndex={-1}
              aria-label={t(`rectEdit.handle.${handle}`)}
              aria-valuenow={0}
              className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-background bg-primary"
              style={{
                left: spot.left,
                top: spot.top,
                cursor: spot.cursor,
                pointerEvents: 'auto',
                touchAction: 'none',
              }}
              onPointerDown={onHandleDown(handle)}
              onPointerMove={onHandleMove}
              onPointerUp={() => {
                dragRef.current = null
              }}
              onPointerCancel={() => {
                dragRef.current = null
              }}
            />
          )
        })}
      </div>
    </div>
  )
}
