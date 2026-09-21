import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import ProjectNavigation from '../../../components/ProjectNavigation'
import { HEADER_OFFSET } from '../../../components/panelStyles'
import { useMobileWorkspace } from '../../../hooks/useMobileWorkspace'
import { useTranslation } from '../../../i18n'
import { isWorkbenchMode, useStore } from '../../../store'
import AgentJobInbox from '../../agent/components/AgentJobInbox'
import AgentPanel from '../../agent/components/AgentPanel'
import AgentSuggestions from '../../agent/components/AgentSuggestions'
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
  // 收起侧栏时左上角有一颗品牌按钮，顶行要从它右边开始排。
  const sidebarExpanded = useStore(
    (state) => state.sidebarExpanded ?? !isWorkbenchMode(state.appMode),
  )
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
  // 首页停在 `/`，起手工作区不占地址（见 projectStore.activate）。第一句话落下、
  // 或画布上真有了东西，这个工作区才成为一个「项目」，这时补一条 `/p/<项目>` 的历史。
  useEffect(() => {
    if (showWelcome || !project) return
    if ((globalThis.location?.pathname ?? '/').replace(/\/+$/, '') !== '') return
    writeProjectRoute(project.id)
  }, [showWelcome, project])
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
    <div
      className="studio-shell fixed bottom-0 right-0 z-30"
      style={{ top: HEADER_OFFSET, left: 'var(--app-sidebar-width)' }}
    >
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
          {/* 顶行排在对话卡片**上方**、与卡片同宽同左边界：logo（收起侧栏时那颗按钮）右边跟
          项目名与切换。同步状态不在这里出声——出错走 toast，画布上不挂常驻提示。 */}
          {hasAgent ? (
            <div className="studio-chat-column">
              <div className="studio-canvas-topbar">
                {!sidebarExpanded && (
                  <img
                    src="/brand/icon-512.png"
                    alt=""
                    className="h-7 w-7 shrink-0 rounded-lg"
                    aria-hidden="true"
                  />
                )}
                <ProjectNavigation />
              </div>
              <AgentPanel
                doc={doc}
                editor={editor}
                mobile={mobile}
                onViewCanvas={() => setMobileView('canvas')}
              />
            </div>
          ) : open || mobile ? (
            <aside
              className="studio-sidebar studio-sidebar--direct"
              style={{ width: 340 }}
              aria-label={t('sidebar.title')}
            >
              <div className="flex items-center justify-between px-4 pb-2 pt-3">
                <span className="text-[13px] font-medium text-foreground">
                  {t('sidebar.title')}
                </span>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label={t('sidebar.collapseAria')}
                  className="grid h-7 w-7 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden="true">
                    <path
                      d="M10 3.5 5.5 8l4.5 4.5"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              </div>
              <div className="studio-chat-empty px-4">
                <h3>{t('sidebar.emptyTitle')}</h3>
                <p>{t('sidebar.emptyBody')}</p>
                {/* 起手示例：点一下填进下面的输入框，发不发由用户决定。 */}
                <AgentSuggestions className="studio-suggestions mt-5" />
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
            {!loading && !loadFailed && <KonvaCanvas editor={editor} />}
            <PlaceholderOverlay editor={editor} />
            <CanvasVideoOverlay editor={editor} />
            <CanvasVideoToolbar editor={editor} />
            <TimelineEditorHost editor={editor} />
            <FilmExportStatus />
            <CanvasToolbar doc={doc} />
            <StylePanel doc={doc} />
            {/* 后台任务入口贴画布右上角：任务落的是画布，进度和定位就该在画布上，
            不占对话顶上的常驻位置。 */}
            {hasAgent && (
              <div className="pointer-events-none absolute right-4 top-4 z-[420] flex justify-end">
                <AgentJobInbox />
              </div>
            )}
            {saveFailed && (
              <div
                role="alert"
                className="absolute right-4 top-16 z-[410] max-w-xs rounded-xl border border-warning/40 bg-muted p-3 text-xs text-warning shadow-lg"
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
                <p>{hasAgent ? t('empty.bodyAgent') : t('empty.bodyDirect')}</p>
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
