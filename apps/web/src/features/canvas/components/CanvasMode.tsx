import { Excalidraw } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import { useEffect, useState } from 'react'
import { useStore } from '../../../store'
import { CanvasEditor } from '../lib/editor'
import { loadScene, PERSIST_DEBOUNCE_MS, saveScene } from '../lib/persistence'
import { placeImagesOnCanvas } from '../lib/placeholderShapeOps'
import { computePlaceholderTarget } from '../lib/placement'
import { recoverCanvasTasks } from '../lib/recoverCanvasTasks'
import CanvasGenerateBar from './CanvasGenerateBar'
import PlaceholderOverlay from './PlaceholderOverlay'

/** 画布顶部让出 Header（安全区 + 3.5rem，与 index.css 的 .safe-header-inner 对齐）。 */
const HEADER_OFFSET = 'calc(var(--safe-area-top) + 3.5rem)'

/**
 * 创作模式：基于 Excalidraw（MIT，无 license 闸）的无限画布。
 * - 持久化走自建 IndexedDB 场景快照（lib/persistence.ts），onChange 防抖落盘
 * - 固定暗色主题 + 网格背景
 * - 占位框状态 UI 由 PlaceholderOverlay 浮层渲染（元素本体只画虚线框）
 */
export default function CanvasMode() {
  const [editor, setEditor] = useState<CanvasEditor | null>(null)

  // 挂载后按序：恢复持久化场景 → 续接 / 失效未完成任务（决策 7）→ 消费「工作台图片 →
  // 画布」handoff 队列 → 订阅变更防抖落盘。落盘订阅在恢复完成后才挂上，避免把
  // 「尚未加载完的空场景」写回覆盖存档。
  useEffect(() => {
    if (!editor) return
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
        void placeImagesOnCanvas(editor, pending, computePlaceholderTarget(editor, null))
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
    <div className="fixed inset-x-0 bottom-0 z-30" style={{ top: HEADER_OFFSET }}>
      <div className="relative h-full w-full">
        <Excalidraw
          excalidrawAPI={(api) => setEditor(new CanvasEditor(api))}
          theme="dark"
          gridModeEnabled
          langCode="zh-CN"
        />
        {editor && <PlaceholderOverlay editor={editor} />}
        {editor && <CanvasGenerateBar editor={editor} />}
      </div>
    </div>
  )
}
