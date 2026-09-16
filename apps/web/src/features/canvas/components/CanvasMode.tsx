import { useEffect, useRef, useSyncExternalStore } from 'react'
import { HEADER_OFFSET } from '../../../components/panelStyles'
import { useStore } from '../../../store'
import AgentPanel from '../../agent/components/AgentPanel'
import { agentPanelPresent } from '../../agent/panelLayout'
import { useAgentStore } from '../../agent/store'
import type { CanvasEditor } from '../lib/editor'
import { importImageFiles } from '../lib/importImages'
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
 * - 对话与画布分栏；占位框状态 UI 由 PlaceholderOverlay 浮层渲染
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
  const hasContent = useSyncExternalStore(doc.subscribe, () => doc.elements.length > 0)
  const open = useAgentStore((state) => state.open)
  const setOpen = useAgentStore((state) => state.setOpen)
  const fileInput = useRef<HTMLInputElement>(null)
  const hasAgent = agentPanelPresent()
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
    <div className="studio-shell fixed inset-x-0 bottom-0 z-30" style={{ top: HEADER_OFFSET }}>
      <div className="studio-layout" inert={loading || loadFailed}>
        {hasAgent ? (
          <AgentPanel doc={doc} editor={editor} />
        ) : open ? (
          <aside
            className="studio-sidebar studio-sidebar--direct"
            style={{ width: 340 }}
            aria-label="图片创作"
          >
            <div className="flex justify-between px-4 text-xs">
              <span>图片创作</span>
              <button type="button" onClick={() => setOpen(false)} aria-label="收起面板">
                收起 ←
              </button>
            </div>
            <div className="studio-chat-empty px-4">
              <span className="studio-spark">✧</span>
              <h3>从一个想法开始</h3>
              <p>描述画面，或将参考图拖入右侧画布。选中图片后，可以继续生成新的版本。</p>
            </div>
            <CanvasGenerateBar editor={editor} />
          </aside>
        ) : (
          <button type="button" className="studio-open-chat" onClick={() => setOpen(true)}>
            展开创作
          </button>
        )}
        <section className="studio-canvas" aria-label="创作画布">
          <div className="studio-canvas-heading">
            <strong>我的画布</strong>
            <span>
              {saveFailed ? '保存失败' : loading ? '正在恢复' : '自动保存'} · 拖入图片开始创作
            </span>
          </div>
          {!loading && !loadFailed && <KonvaCanvas editor={editor} />}
          <PlaceholderOverlay editor={editor} />
          <CanvasVideoOverlay editor={editor} />
          <CanvasToolbar doc={doc} />
          <StylePanel doc={doc} />
          {saveFailed && (
            <div
              role="alert"
              className="absolute right-4 top-4 z-[410] max-w-xs rounded-xl border border-warning/40 bg-muted p-3 text-xs text-warning shadow-lg"
            >
              <p>画布保存失败，内容仍在当前页面。请重试，成功前不要刷新或关闭。</p>
              <button
                type="button"
                className="mt-2 underline"
                onClick={() => void workspace.flush()}
              >
                重试保存
              </button>
            </div>
          )}
          {/* 右下角控件栈：小地图贴角，快捷键速查叠在它上面。两者共用一列，天然不重叠；
            底部工具条居中、智能体面板在左，都不落在这一列里。 */}
          <div className="pointer-events-none absolute bottom-24 right-4 z-[400] hidden flex-col items-end gap-2 sm:flex">
            <CanvasShortcutsHint />
            <CanvasMinimap editor={editor} />
          </div>
          {!hasContent && !loading && !loadFailed && (
            <div className="studio-empty">
              <img src="/brand/muvloom-icon.svg" alt="" />
              <h2>给想象，一个画面。</h2>
              <p>
                {hasAgent
                  ? '在左侧描述你的想法，作品会在这里展开。'
                  : '在左侧输入画面描述，开始你的创作。'}
                <br />
                也可以拖入图片，继续探索新的可能。
              </p>
              <button
                type="button"
                className="studio-secondary"
                onClick={() => fileInput.current?.click()}
              >
                ＋ 导入参考图片
              </button>
            </div>
          )}
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            aria-label="导入画布图片"
            onChange={(event) => {
              const files = [...(event.currentTarget.files ?? [])]
              event.currentTarget.value = ''
              void importImageFiles(editor, files, {
                x: editor.getViewportPageBounds().midX,
                y: editor.getViewportPageBounds().midY,
              })
                .then((count) => {
                  if (!count)
                    useStore.getState().showToast('未能导入图片，请选择有效的图片文件', 'error')
                })
                .catch(() => useStore.getState().showToast('图片导入失败，请重试', 'error'))
            }}
          />
        </section>
      </div>
      {(loading || loadFailed) && (
        <div role={loadFailed ? 'alert' : 'status'} className="studio-canvas-status">
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
