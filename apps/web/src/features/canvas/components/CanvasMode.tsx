import { Tldraw } from 'tldraw'
import 'tldraw/tldraw.css'
import { recoverCanvasTasks } from '../lib/recoverCanvasTasks'
import { GenerationPlaceholderShapeUtil } from '../shapes/GenerationPlaceholderShapeUtil'
import CanvasGenerateBar from './CanvasGenerateBar'

/** 注册画布自定义 shape（生成占位框）。 */
const customShapeUtils = [GenerationPlaceholderShapeUtil]

/** 画布顶部让出 Header（安全区 + 3.5rem，与 index.css 的 .safe-header-inner 对齐）。 */
const HEADER_OFFSET = 'calc(var(--safe-area-top) + 3.5rem)'

/** tldraw 内置 IndexedDB 持久化的命名空间；与项目 image-playground DB 隔离互不影响。 */
const CANVAS_PERSISTENCE_KEY = 'image-playground-canvas'

/**
 * 创作模式：基于 tldraw 的无限画布。
 * - 持久化走 tldraw 自带 IndexedDB（persistenceKey）
 * - 固定暗色背景 + 点阵网格（isGridMode，tldraw 默认网格即点阵）
 */
export default function CanvasMode() {
  return (
    <div className="fixed inset-x-0 bottom-0 z-30" style={{ top: HEADER_OFFSET }}>
      <Tldraw
        persistenceKey={CANVAS_PERSISTENCE_KEY}
        shapeUtils={customShapeUtils}
        onMount={(editor) => {
          // 固定暗色主题（仅在非暗色时切，避免污染 undo/首帧闪烁）。
          if (editor.user.getUserPreferences().colorScheme !== 'dark') {
            editor.user.updateUserPreferences({ colorScheme: 'dark' })
          }
          // 打开点阵网格背景（tldraw 默认网格渲染为点阵）。
          if (!editor.getInstanceState().isGridMode) {
            editor.updateInstanceState({ isGridMode: true })
          }
          // 画布加载完成后扫描运行态占位框，续接 / 失效未完成任务（决策 7）。
          recoverCanvasTasks(editor)
        }}
      >
        <CanvasGenerateBar />
      </Tldraw>
    </div>
  )
}
