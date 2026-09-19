import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { HEADER_OFFSET } from '../../../components/panelStyles'
import { useMobileWorkspace } from '../../../hooks/useMobileWorkspace'
import { useTranslation } from '../../../i18n'
import { useStore } from '../../../store'
import AgentPanel from '../../agent/components/AgentPanel'
import { conversationStarted } from '../../agent/lib/panelMessages'
import { agentPanelPresent } from '../../agent/panelLayout'
import { useAgentStore } from '../../agent/store'
import { useCanvasComposer } from '../composerStore'
import type { CanvasEditor } from '../lib/editor'
import { importImageFiles } from '../lib/importImages'
import { placeImagesIntoTargets } from '../lib/placeholderShapeOps'
import { computePlaceholderTargets } from '../lib/placement'
import { projectDisplayName } from '../lib/projectRepository'
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
import CanvasVideoToolbar from './CanvasVideoToolbar'
import FilmExportStatus from './FilmExportStatus'
import KonvaCanvas from './KonvaCanvas'
import PlaceholderOverlay from './PlaceholderOverlay'
import ProjectSyncStatus from './ProjectSyncStatus'
import ProjectWelcome from './ProjectWelcome'
import StylePanel from './StylePanel'
import TimelineEditorHost from './TimelineEditor'

/**
 * 创作模式：自建无限画布（Konva 渲染，MIT，无任何 license 依赖）。
 * - 持久化走自建 IndexedDB 场景快照（lib/persistence.ts），变更防抖落盘
 * - 对话与画布分栏；占位框状态 UI 由 PlaceholderOverlay 浮层渲染
 */
export default function CanvasMode() {
  const { t } = useTranslation('canvas')
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
  // 视频入口就是这张画布，只是生成方式预置到视频：每次进入都预置一次，之后由用户自己切。
  const videoEntry = useStore((state) => state.appMode === 'video')
  useEffect(() => {
    if (videoEntry) useCanvasComposer.getState().requestVideo()
  }, [videoEntry])
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
            {t('project.backToProjects')}
          </button>
        </div>
      </div>
    )
  if (!projectsLoaded)
    return (
      <div className="studio-canvas-status" role={projectError ? 'alert' : 'status'}>
        <div>
          {projectError || t('project.restoring')}
          {projectError && (
            <button type="button" className="ml-3 underline" onClick={() => void initialize()}>
              {t('project.reload')}
            </button>
          )}
        </div>
      </div>
    )
  return <CanvasWorkspaceView key={workspace.id} workspace={workspace} />
}

function CanvasWorkspaceView({ workspace }: { workspace: CanvasWorkspace }) {
  const { t } = useTranslation('canvas')
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
  // 敲下回车就切到工作区：消息先上屏、状态行亮「发送中」，不等服务端回 turnStart。
  const started = useAgentStore((state) => conversationStarted(state.messages))
  const showWelcome =
    hasAgent && !hasContent && !project?.hasContent && !project?.workspaceOpened && !started
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

  // 画布已经开着时也可能有图送进来（素材库、灯箱里的「生成视频」），所以跟着队列长度重跑。
  const pendingImages = useStore((state) => state.pendingCanvasImages.length)
  useEffect(() => {
    if (loading || loadFailed || pendingImages === 0) return
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
  }, [editor, workspace, loading, loadFailed, pendingImages])

  return (
    <div className="studio-shell fixed inset-x-0 bottom-0 z-30" style={{ top: HEADER_OFFSET }}>
      {showWelcome && !mobile && !loading && !loadFailed ? (
        <ProjectWelcome workspace={workspace} />
      ) : (
        <div className="studio-layout" data-mobile-view={mobileView} inert={loading || loadFailed}>
          <div className="studio-mobile-switch" role="group" aria-label={t('mobileSwitch.aria')}>
            <button
              type="button"
              aria-pressed={mobileView === 'chat'}
              onClick={() => setMobileView('chat')}
            >
              {t('mobileSwitch.chat')}
            </button>
            <button
              type="button"
              aria-pressed={mobileView === 'canvas'}
              onClick={() => setMobileView('canvas')}
            >
              {t('mobileSwitch.canvas')}
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
              aria-label={t('sidebar.title')}
            >
              <div className="flex justify-between px-4 text-xs">
                <span>{t('sidebar.title')}</span>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label={t('sidebar.collapseAria')}
                >
                  {t('sidebar.collapse')}
                </button>
              </div>
              <div className="studio-chat-empty px-4">
                <span className="studio-spark">✧</span>
                <h3>{t('sidebar.emptyTitle')}</h3>
                <p>{t('sidebar.emptyBody')}</p>
              </div>
              <CanvasGenerateBar editor={editor} />
            </aside>
          ) : (
            <button type="button" className="studio-open-chat" onClick={() => setOpen(true)}>
              {t('sidebar.openChat')}
            </button>
          )}
          <section
            className="studio-canvas"
            aria-label={t('workspace.canvasAria')}
            inert={mobile && mobileView !== 'canvas'}
          >
            <div className="studio-canvas-heading">
              <strong>
                {project ? projectDisplayName(project.name) : t('workspace.untitled')}
              </strong>
              {workspace.cloud ? (
                <ProjectSyncStatus session={workspace.cloud} />
              ) : (
                <span>
                  {saveFailed
                    ? t('workspace.saveFailed')
                    : loading
                      ? t('workspace.restoring')
                      : t('workspace.autoSaved')}{' '}
                  · {t('workspace.dropHint')}
                </span>
              )}
            </div>
            {!loading && !loadFailed && <KonvaCanvas editor={editor} />}
            <PlaceholderOverlay editor={editor} />
            <CanvasVideoOverlay editor={editor} />
            <CanvasVideoToolbar editor={editor} />
            <TimelineEditorHost editor={editor} />
            <FilmExportStatus />
            <CanvasToolbar doc={doc} />
            <StylePanel doc={doc} />
            {saveFailed && (
              <div
                role="alert"
                className="absolute right-4 top-4 z-[410] max-w-xs rounded-xl border border-warning/40 bg-muted p-3 text-xs text-warning shadow-lg"
              >
                <p>{t('saveError.message')}</p>
                <button
                  type="button"
                  className="mt-2 underline"
                  onClick={() => void workspace.flush()}
                >
                  {t('saveError.retry')}
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
                <h2>{t('empty.title')}</h2>
                <p>
                  {hasAgent ? t('empty.bodyAgent') : t('empty.bodyDirect')}
                  <br />
                  {t('empty.bodyDrop')}
                </p>
                <button
                  type="button"
                  className="studio-secondary"
                  onClick={() => fileInput.current?.click()}
                >
                  {t('empty.import')}
                </button>
              </div>
            )}
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              aria-label={t('import.inputAria')}
              onChange={(event) => {
                const files = [...(event.currentTarget.files ?? [])]
                event.currentTarget.value = ''
                void importImageFiles(editor, files, {
                  x: editor.getViewportPageBounds().midX,
                  y: editor.getViewportPageBounds().midY,
                })
                  .then((count) => {
                    if (!count) useStore.getState().showToast(t('import.noneImported'), 'error')
                  })
                  .catch(() => useStore.getState().showToast(t('import.failed'), 'error'))
              }}
            />
          </section>
        </div>
      )}
      {(loading || loadFailed) && (
        <div role={loadFailed ? 'alert' : 'status'} className="studio-canvas-status">
          {loadFailed ? (
            <div>
              <p>{t('loadError.message')}</p>
              <button type="button" className="mt-2 underline" onClick={workspace.retryLoad}>
                {t('loadError.retry')}
              </button>
            </div>
          ) : (
            t('loading.restoring')
          )}
        </div>
      )}
    </div>
  )
}
