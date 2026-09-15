import { useEffect, useSyncExternalStore } from 'react'
import { HEADER_OFFSET } from '../../../components/panelStyles'
import { useStore } from '../../../store'
import AgentPanel from '../../agent/components/AgentPanel'
import { agentPanelPresent } from '../../agent/panelLayout'
import type { CanvasEditor } from '../lib/editor'
import { placeImagesIntoTargets } from '../lib/placeholderShapeOps'
import { computePlaceholderTargets } from '../lib/placement'
import {
  type CanvasWorkspace,
  currentCanvasWorkspace,
  showCanvasWorkspace,
  subscribeCanvasWorkspace,
} from '../lib/workspaces'
import CanvasGenerateBar from './CanvasGenerateBar'
import CanvasMinimap from './CanvasMinimap'
import CanvasShortcutsHint from './CanvasShortcutsHint'
import CanvasToolbar from './CanvasToolbar'
import CanvasVideoOverlay from './CanvasVideoOverlay'
import KonvaCanvas from './KonvaCanvas'
import PlaceholderOverlay from './PlaceholderOverlay'
import StylePanel from './StylePanel'

/**
 * 创作模式：自建无限画布（Konva 渲染，MIT，无任何 license 依赖）。
 * - 持久化走自建 IndexedDB 场景快照（lib/persistence.ts），变更防抖落盘
 * - 暗色 + 点阵网格；占位框状态 UI 由 PlaceholderOverlay 浮层渲染
 */
export default function CanvasMode() {
  const workspace = useSyncExternalStore(subscribeCanvasWorkspace, currentCanvasWorkspace)
  useEffect(() => {
    showCanvasWorkspace(true)
    return () => showCanvasWorkspace(false)
  }, [])
  return <CanvasWorkspaceView key={workspace.id} workspace={workspace} />
}

function CanvasWorkspaceView({ workspace }: { workspace: CanvasWorkspace }) {
  const { doc, editor } = workspace
  const { loading, loadFailed, saveFailed } = useSyncExternalStore(
    workspace.subscribe,
    workspace.getSnapshot,
  )

  useEffect(() => {
    if (!import.meta.env.DEV) return
    ;(window as unknown as { __canvasEditor?: CanvasEditor }).__canvasEditor = editor
  }, [editor])

  useEffect(() => {
    if (loading || loadFailed) return
    const pending = useStore.getState().consumeCanvasImages()
    if (!pending.length) return
    void placeImagesIntoTargets(
      editor,
      pending.map((dataUrl) => ({ dataUrl })),
      computePlaceholderTargets(editor, null, pending.length),
    ).then(
      () => workspace.flush(),
      (error) => console.warn('[canvas] 工作台图片放置失败', error),
    )
  }, [editor, workspace, loading, loadFailed])

  return (
    <div className="fixed inset-x-0 bottom-0 z-30 bg-[#101011]" style={{ top: HEADER_OFFSET }}>
      <div className="relative h-full w-full" inert={loading || loadFailed}>
        {!loading && !loadFailed && <KonvaCanvas editor={editor} />}
        <PlaceholderOverlay editor={editor} />
        <CanvasVideoOverlay editor={editor} />
        <CanvasToolbar doc={doc} />
        <StylePanel doc={doc} />
        {saveFailed && (
          <div
            role="alert"
            className="absolute right-4 top-4 z-[410] max-w-xs rounded-xl border border-amber-400/40 bg-gray-900 p-3 text-xs text-amber-200 shadow-lg"
          >
            <p>画布保存失败，内容仍在当前页面。请重试，成功前不要刷新或关闭。</p>
            <button type="button" className="mt-2 underline" onClick={() => void workspace.flush()}>
              重试保存
            </button>
          </div>
        )}
        {/* 右下角控件栈：小地图贴角，快捷键速查叠在它上面。两者共用一列，天然不重叠；
            底部工具条居中、智能体面板在左，都不落在这一列里。 */}
        <div className="pointer-events-none absolute bottom-4 right-4 z-[400] hidden flex-col items-end gap-2 sm:flex">
          <CanvasShortcutsHint />
          <CanvasMinimap editor={editor} />
        </div>
        {/* 智能体在场时输入框只留一个：参数收进面板输入框上方的浮层，创作走对话那条路。
            能力关着的部署（免费形态）仍然靠这条生成条，不能删。 */}
        {!agentPanelPresent() && <CanvasGenerateBar editor={editor} />}
        <AgentPanel doc={doc} editor={editor} />
      </div>
      {(loading || loadFailed) && (
        <div
          role={loadFailed ? 'alert' : 'status'}
          className="absolute inset-0 z-[420] flex items-center justify-center bg-gray-950/80 text-sm text-gray-200"
        >
          {loadFailed ? (
            <div>
              <p>画布读取失败，原内容已保留，请重试。</p>
              <button type="button" className="mt-2 underline" onClick={workspace.retryLoad}>
                重新读取
              </button>
            </div>
          ) : (
            '正在恢复画布…'
          )}
        </div>
      )}
    </div>
  )
}
