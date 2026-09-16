import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { HEADER_OFFSET } from '../../../components/panelStyles'
import { useMobileWorkspace } from '../../../hooks/useMobileWorkspace'
import { useStore } from '../../../store'
import AgentPanel from '../../agent/components/AgentPanel'
import { agentPanelPresent } from '../../agent/panelLayout'
import { useAgentStore } from '../../agent/store'
import type { CanvasEditor } from '../lib/editor'
import { importImageFiles } from '../lib/importImages'
import { placeImagesIntoTargets } from '../lib/placeholderShapeOps'
import { computePlaceholderTargets } from '../lib/placement'
import { writeProjectRoute } from '../lib/projectRoute'
import {
  type CanvasWorkspace,
  currentCanvasWorkspace,
  selectCanvasWorkspace,
  showCanvasWorkspace,
  subscribeCanvasWorkspace,
} from '../lib/workspaces'
import { useCanvasProjectStore } from '../projectStore'
import CanvasGenerateBar from './CanvasGenerateBar'
import CanvasMinimap from './CanvasMinimap'
import CanvasShortcutsHint from './CanvasShortcutsHint'
import CanvasToolbar from './CanvasToolbar'
import CanvasVideoOverlay from './CanvasVideoOverlay'
import KonvaCanvas from './KonvaCanvas'
import PlaceholderOverlay from './PlaceholderOverlay'
import ProjectSyncStatus from './ProjectSyncStatus'
import ProjectWelcome from './ProjectWelcome'
import StylePanel from './StylePanel'

/**
 * 创作模式：自建无限画布（Konva 渲染，MIT，无任何 license 依赖）。
 * - 持久化走自建 IndexedDB 场景快照（lib/persistence.ts），变更防抖落盘
 * - 对话与画布分栏；占位框状态 UI 由 PlaceholderOverlay 浮层渲染
 */
export default function CanvasMode() {
  const workspace = useSyncExternalStore(subscribeCanvasWorkspace, currentCanvasWorkspace)
  const projectsLoaded = useCanvasProjectStore((state) => state.loaded)
  const routeError = useCanvasProjectStore((state) => state.routeError)
  const projectError = useCanvasProjectStore((state) => state.error)
  const initialize = () =>
    useCanvasProjectStore
      .getState()
      .load()
      .then(() => {
        const state = useCanvasProjectStore.getState()
        const project = state.projects.find((one) => one.id === state.activeId)
        selectCanvasWorkspace(project?.conversationId ?? null)
      })
      .catch(() => {})
  useEffect(() => {
    void initialize()
  }, [])
  useEffect(() => {
    showCanvasWorkspace(true)
    return () => showCanvasWorkspace(false)
  }, [])
  if (routeError)
    return (
      <div className="studio-canvas-status" role="alert">
        <div>
          {routeError}
          <button
            type="button"
            className="ml-3 underline"
            onClick={() => {
              const active = useCanvasProjectStore.getState().activeId
              if (active) {
                writeProjectRoute(active, true)
                useCanvasProjectStore.setState({ routeError: null })
              } else location.assign('/')
            }}
          >
            返回项目
          </button>
        </div>
      </div>
    )
  if (!projectsLoaded)
    return (
      <div className="studio-canvas-status" role={projectError ? 'alert' : 'status'}>
        <div>
          {projectError || '正在恢复项目…'}
          {projectError && (
            <button type="button" className="ml-3 underline" onClick={() => void initialize()}>
              重新加载
            </button>
          )}
        </div>
      </div>
    )
  return <CanvasWorkspaceView key={workspace.id} workspace={workspace} />
}

function CanvasWorkspaceView({ workspace }: { workspace: CanvasWorkspace }) {
  const mobile = useMobileWorkspace()
  const [mobileView, setMobileView] = useState<'chat' | 'canvas'>('chat')
  const { doc, editor } = workspace
  const hasContent = useSyncExternalStore(doc.subscribe, () => doc.elements.length > 0)
  const open = useAgentStore((state) => state.open)
  const setOpen = useAgentStore((state) => state.setOpen)
  const fileInput = useRef<HTMLInputElement>(null)
  const hasAgent = agentPanelPresent()
  const project = useCanvasProjectStore((state) =>
    state.projects.find((one) => one.id === state.activeId),
  )
  const accepted = useAgentStore((state) =>
    state.messages.some((one) => one.kind !== 'text' || !one.pending),
  )
  const showWelcome = hasAgent && !hasContent && !project?.hasContent && !accepted
  useEffect(() => {
    if (hasAgent) void useAgentStore.getState().load()
  }, [hasAgent])
  const { loading, loadFailed, saveFailed } = useSyncExternalStore(
    workspace.subscribe,
    workspace.getSnapshot,
  )

  useEffect(() => {
    if (!import.meta.env.DEV) return
    ;(window as unknown as { __canvasEditor?: CanvasEditor }).__canvasEditor = editor
  }, [editor])

  useEffect(() => {
    if (!workspace.needsInitialFit) return
    const fit = () => {
      if (doc.viewport.width <= 1 || doc.viewport.height <= 1) return
      workspace.needsInitialFit = false
      unsubscribe()
      editor.scrollToElements(doc.elements.map((one) => one.id))
    }
    const unsubscribe = doc.subscribe(fit)
    fit()
    return unsubscribe
  }, [doc, editor, workspace, loading])

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
      {showWelcome && !mobile && !loading && !loadFailed ? (
        <ProjectWelcome workspace={workspace} />
      ) : (
        <div className="studio-layout" data-mobile-view={mobileView} inert={loading || loadFailed}>
          <div className="studio-mobile-switch" role="group" aria-label="创作视图">
            <button
              type="button"
              aria-pressed={mobileView === 'chat'}
              onClick={() => setMobileView('chat')}
            >
              对话
            </button>
            <button
              type="button"
              aria-pressed={mobileView === 'canvas'}
              onClick={() => setMobileView('canvas')}
            >
              画布
            </button>
          </div>
          {hasAgent ? (
            <AgentPanel
              doc={doc}
              editor={editor}
              mobile={mobile}
              onViewCanvas={() => setMobileView('canvas')}
            />
          ) : open || mobile ? (
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
          <section
            className="studio-canvas"
            aria-label="创作画布"
            inert={mobile && mobileView !== 'canvas'}
          >
            <div className="studio-canvas-heading">
              <strong>{project?.name ?? '我的画布'}</strong>
              {workspace.cloud ? (
                <ProjectSyncStatus session={workspace.cloud} />
              ) : (
                <span>
                  {saveFailed ? '本机保存失败' : loading ? '正在恢复' : '本机自动保存'} ·
                  拖入图片开始创作
                </span>
              )}
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
                  {hasAgent ? '描述你的想法，作品会在这里展开。' : '输入画面描述，开始你的创作。'}
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
      )}
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
