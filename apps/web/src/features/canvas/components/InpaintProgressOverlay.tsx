import { useSyncExternalStore } from 'react'
import { useTranslation } from '../../../i18n'
import type { CanvasEditor } from '../lib/editor'

/**
 * 正在被局部重绘的**源图卡片**上那层「局部重绘中…」。
 *
 * 状态不另存一份：唯一真相源仍是 loading 占位框的 `meta.inpaintSourceId`（随画布持久化），
 * 这一层只是它的投影，所以刷新之后照样盖得回来，也不会和占位框的状态走岔。
 */
export default function InpaintProgressOverlay({ editor }: { editor: CanvasEditor }) {
  const { t } = useTranslation('canvas')
  useSyncExternalStore(editor.doc.subscribe, () => editor.doc.version)
  const running = editor
    .getPlaceholders()
    .filter((one) => one.status === 'loading' && one.meta.inpaintSourceId)
  if (running.length === 0) return null
  const { camera } = editor.doc

  return (
    <div className="pointer-events-none absolute inset-0 z-[15] overflow-hidden">
      {running.map((placeholder) => {
        const element = editor.getElement(placeholder.meta.inpaintSourceId ?? '')
        if (element?.type !== 'image') return null
        return (
          <div
            key={placeholder.id}
            className="absolute grid place-items-center bg-background/55"
            style={{
              left: (element.x - camera.x) * camera.zoom,
              top: (element.y - camera.y) * camera.zoom,
              width: element.width * camera.zoom,
              height: element.height * camera.zoom,
              // Konva 的 rotation 绕元素左上角；遮罩要贴着那张图，不能贴它的 AABB。
              transform: `rotate(${element.rotation}deg)`,
              transformOrigin: '0 0',
            }}
          >
            <span className="flex items-center gap-2 rounded-full bg-card/90 px-3 py-1 text-xs font-medium text-foreground shadow">
              <span
                aria-hidden="true"
                className="h-3 w-3 rounded-full border-2 border-primary border-t-transparent"
                style={{ animation: 'canvas-placeholder-spin 0.8s linear infinite' }}
              />
              {t('inpaint.running')}
            </span>
          </div>
        )
      })}
    </div>
  )
}
