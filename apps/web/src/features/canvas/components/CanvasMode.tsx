import { useEffect, useState } from 'react'
import { useStore } from '../../../store'
import { CanvasDoc } from '../lib/canvasDoc'
import { CanvasEditor } from '../lib/editor'
import { loadScene, PERSIST_DEBOUNCE_MS, saveScene } from '../lib/persistence'
import { placeImagesOnCanvas } from '../lib/placeholderShapeOps'
import { computePlaceholderTarget } from '../lib/placement'
import { recoverCanvasTasks } from '../lib/recoverCanvasTasks'
import CanvasGenerateBar from './CanvasGenerateBar'
import CanvasShortcutsHint from './CanvasShortcutsHint'
import CanvasToolbar from './CanvasToolbar'
import KonvaCanvas from './KonvaCanvas'
import PlaceholderOverlay from './PlaceholderOverlay'
import StylePanel from './StylePanel'

/** 画布顶部让出 Header（安全区 + 3.5rem，与 index.css 的 .safe-header-inner 对齐）。 */
const HEADER_OFFSET = 'calc(var(--safe-area-top) + 3.5rem)'

/**
 * 创作模式：自建无限画布（Konva 渲染，MIT，无任何 license 依赖）。
 * - 持久化走自建 IndexedDB 场景快照（lib/persistence.ts），变更防抖落盘
 * - 暗色 + 点阵网格；占位框状态 UI 由 PlaceholderOverlay 浮层渲染
 */
export default function CanvasMode() {
  const [{ doc, editor }] = useState(() => {
    const canvasDoc = new CanvasDoc()
    return { doc: canvasDoc, editor: new CanvasEditor(canvasDoc) }
  })

  // DEV 调试出口：E2E / 排查用（生产构建剔除）。
  useEffect(() => {
    if (!import.meta.env.DEV) return
    ;(window as unknown as { __canvasEditor?: CanvasEditor }).__canvasEditor = editor
  }, [editor])

  // 挂载后按序：恢复持久化场景 → 续接 / 失效未完成任务（决策 7）→ 消费「工作台图片 →
  // 画布」handoff 队列 → 订阅变更防抖落盘。落盘订阅在恢复完成后才挂上，避免把
  // 「尚未加载完的空场景」写回覆盖存档。
  useEffect(() => {
    let disposed = false
    let loaded = false
    let timer: number | undefined
    let unsubscribe: (() => void) | undefined
    void (async () => {
      await loadScene(editor)
      if (disposed) return
      loaded = true
      recoverCanvasTasks(editor)
      const pending = useStore.getState().consumeCanvasImages()
      if (pending.length > 0) {
        placeImagesOnCanvas(editor, pending, computePlaceholderTarget(editor, null)).then(
          // 放置若在卸载后才完成，最终落盘已错过 → 补存一次
          () => {
            if (disposed) void saveScene(editor)
          },
          (err) => console.warn('[canvas] 工作台图片放置失败', err),
        )
      }
      unsubscribe = editor.onChange(() => {
        window.clearTimeout(timer)
        timer = window.setTimeout(() => void saveScene(editor), PERSIST_DEBOUNCE_MS)
      })
    })()
    return () => {
      disposed = true
      unsubscribe?.()
      window.clearTimeout(timer)
      // 卸载前把最后的变更落盘（切回工作台不丢内容）；未完成加载则不写，防覆盖。
      if (loaded) void saveScene(editor)
    }
  }, [editor])

  return (
    <div className="fixed inset-x-0 bottom-0 z-30 bg-[#101011]" style={{ top: HEADER_OFFSET }}>
      <div className="relative h-full w-full">
        <KonvaCanvas editor={editor} />
        <PlaceholderOverlay editor={editor} />
        <CanvasToolbar doc={doc} />
        <StylePanel doc={doc} />
        <CanvasShortcutsHint />
        <CanvasGenerateBar editor={editor} />
      </div>
    </div>
  )
}
