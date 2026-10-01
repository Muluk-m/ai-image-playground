import { ArrowLeft, Clapperboard, FolderOpen, PanelLeftOpen, Search } from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import ProjectNavigation from '../../../components/ProjectNavigation'
import { HEADER_OFFSET } from '../../../components/panelStyles'
import { useMobileWorkspace } from '../../../hooks/useMobileWorkspace'
import { useTranslation } from '../../../i18n'
import { safeLocalStorage, scopedStorageName } from '../../../lib/authScope'
import { isClientCapabilityEnabled } from '../../../lib/clientCapabilities'
import { resolveMediaSource } from '../../../lib/cloudMedia'
import { confirmImageBatch } from '../../../lib/confirmImageBatch'
import { acceptImageFiles, filesFromFolderInput } from '../../../lib/imageFiles'
import { useStore } from '../../../store'
import AgentArtifactPane from '../../agent/components/AgentArtifactPane'
import AgentAssetDrawer from '../../agent/components/AgentAssetDrawer'
import AgentCanvasHandoffDialog from '../../agent/components/AgentCanvasHandoffDialog'
import AgentPanel from '../../agent/components/AgentPanel'
import AgentResultShelf from '../../agent/components/AgentResultShelf'
import AgentSuggestions from '../../agent/components/AgentSuggestions'
import { fetchedCanvasId } from '../../agent/lib/artifactDelivery'
import { previewArtifactBitmap } from '../../agent/lib/artifactSource'
import { agentCanvasSink } from '../../agent/lib/canvasSink'
import { conversationStarted } from '../../agent/lib/panelMessages'
import { agentPanelPresent } from '../../agent/panelLayout'
import { useAgentStore } from '../../agent/store'
import type { AgentToolMessage } from '../../agent/types'
import ProductionWorkspace from '../../production/components/ProductionWorkspace'
import { openProductionContent } from '../../production/lib/productionContext'
import {
  backToCurrentProject,
  currentCanvasWorkspace,
  openCurrentProject,
  showCanvasWorkspace,
  subscribeCanvasWorkspace,
} from '../lib/activeProject'
import type { CanvasEditor } from '../lib/editor'
import { importImageFiles } from '../lib/importImages'
import { projectExperience } from '../lib/projectRepository'
import { writeProjectRoute } from '../lib/projectRoute'
import type { CanvasWorkspace } from '../lib/workspaces'
import { useCanvasProjectStore } from '../projectStore'
import CanvasBatchBar from './CanvasBatchBar'
import CanvasGenerateBar from './CanvasGenerateBar'
import CanvasImageToolbar from './CanvasImageToolbar'
import CanvasMinimap from './CanvasMinimap'
import CanvasRectEditLayer from './CanvasRectEditLayer'
import CanvasShortcutsHint from './CanvasShortcutsHint'
import CanvasToolbar from './CanvasToolbar'
import CanvasVideoOverlay from './CanvasVideoOverlay'
import CanvasVideoToolbar from './CanvasVideoToolbar'
import FilmExportStatus from './FilmExportStatus'
import InpaintMaskLayer from './InpaintMaskLayer'
import KonvaCanvas from './KonvaCanvas'
import PlaceholderOverlay from './PlaceholderOverlay'
import ProjectWelcome from './ProjectWelcome'
import StylePanel from './StylePanel'
import TimelineEditorHost from './TimelineEditor'

/**
 * 创作模式：自建无限画布（Konva 渲染，MIT，无任何 license 依赖）。
 * - 持久化走自建 IndexedDB 场景快照（lib/persistence.ts），变更防抖落盘
 * - Agent 项目共用对话/画布双视图；占位框状态 UI 由 PlaceholderOverlay 浮层渲染
 */
export default function CanvasMode() {
  const { t } = useTranslation('canvas')
  const workspace = useSyncExternalStore(subscribeCanvasWorkspace, currentCanvasWorkspace)
  const projectsLoaded = useCanvasProjectStore((state) => state.loaded)
  const routeError = useCanvasProjectStore((state) => state.routeError)
  const projectError = useCanvasProjectStore((state) => state.error)
  useEffect(() => {
    void openCurrentProject()
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
          <button type="button" className="ml-3 underline" onClick={backToCurrentProject}>
            {t('project.backToProjects')}
          </button>
        </div>
      </div>
    )
  if (!projectsLoaded)
    return projectError ? (
      <div className="studio-canvas-status" role="alert">
        <div>
          {projectError}
          <button
            type="button"
            className="ml-3 underline"
            onClick={() => void openCurrentProject()}
          >
            {t('project.reload')}
          </button>
        </div>
      </div>
    ) : (
      <CanvasLoading label={t('project.restoring')} />
    )
  return <CanvasWorkspaceView key={workspace.id} workspace={workspace} />
}

/**
 * 打开画布时的等待：和画布同一张点阵底，中间只有呼吸的品牌标。文字留给读屏，不摆在面上。
 * 淡入有延迟——本机缓存命中时几十毫秒就读完，一闪而过的遮罩比没有更扎眼。
 */
function CanvasLoading({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="studio-canvas-loading">
      <div className="studio-canvas-loading-mark">
        <img src="/brand/muvloom-mark.svg" alt="" />
      </div>
      <span className="sr-only">{label}</span>
    </div>
  )
}

function CanvasWorkspaceView({ workspace }: { workspace: CanvasWorkspace }) {
  const { t } = useTranslation('canvas')
  const { t: tShell } = useTranslation('shell')
  const { t: tProduction } = useTranslation('production')
  const mobile = useMobileWorkspace()
  const project = useCanvasProjectStore((state) =>
    state.projects.find((one) => one.id === state.activeId),
  )
  const [projectView, setProjectView] = useState<'chat' | 'canvas'>(
    project ? projectExperience(project) : 'chat',
  )
  const sidebarExpanded = useStore((state) => state.sidebarExpanded)
  const [selectedResultId, setSelectedResultId] = useState<string | null>(null)
  const [selectedExternalResult, setSelectedExternalResult] = useState<AgentToolMessage | null>(
    null,
  )
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | undefined>()
  const [assetDrawerOpen, setAssetDrawerOpen] = useState(false)
  const productionViewKey = scopedStorageName(`production-view:${workspace.id}`)
  const [productionOpen, setProductionOpen] = useState(
    () => safeLocalStorage.getItem(productionViewKey) === 'true',
  )
  const productionEnabled = isClientCapabilityEnabled('agent:production')
  const productionVisible = productionEnabled && productionOpen && projectView === 'chat'
  const conversationId = useAgentStore((state) => state.conversationId)
  const previewProduction = () => {
    if (!productionEnabled) return
    setProductionOpen(true)
    safeLocalStorage.setItem(productionViewKey, 'true')
    openProductionContent(conversationId)
  }
  const [searchOpen, setSearchOpen] = useState(false)
  const [handoffIds, setHandoffIds] = useState<readonly string[] | null>(null)
  const focusedResult = useRef<string | null>(null)
  const { doc, editor } = workspace
  const hasContent = useSyncExternalStore(doc.subscribe, () => doc.elements.length > 0)
  const open = useAgentStore((state) => state.open)
  const setOpen = useAgentStore((state) => state.setOpen)
  const fileInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  const importFiles = (files: File[]) => {
    const images = acceptImageFiles(files)
    if (images.length === 0) return
    confirmImageBatch(images.length, () => {
      void importImageFiles(editor, images, {
        x: editor.getViewportPageBounds().midX,
        y: editor.getViewportPageBounds().midY,
      })
        .then((count) => {
          if (!count) useStore.getState().showToast(t('import.noneImported'), 'error')
        })
        .catch(() => useStore.getState().showToast(t('import.failed'), 'error'))
    })
  }
  const hasAgent = agentPanelPresent()
  const messages = useAgentStore((state) => state.messages)
  const latestResult = [...messages]
    .reverse()
    .find(
      (message): message is AgentToolMessage =>
        message.kind === 'tool' &&
        message.status === 'succeeded' &&
        (Boolean(message.artifacts?.length) || Boolean(message.fetchedImages?.length)),
    )
  const selectedResult = messages.find(
    (message): message is AgentToolMessage =>
      message.kind === 'tool' && message.id === selectedResultId,
  )
  const activeResult = selectedExternalResult ?? selectedResult ?? latestResult
  const previewResult = (messageId: string, artifactId?: string) => {
    setSelectedExternalResult(null)
    setSelectedResultId(messageId)
    setSelectedArtifactId(artifactId)
    setAssetDrawerOpen(false)
  }
  const previewAsset = (message: AgentToolMessage, artifactId: string) => {
    setSelectedExternalResult(message)
    setSelectedResultId(message.id)
    setSelectedArtifactId(artifactId)
    setAssetDrawerOpen(false)
  }
  const completeHandoff = async (targetId?: string): Promise<boolean> => {
    const selected = handoffIds ?? []
    try {
      const dataUrls = await Promise.all(
        selected.map(async (id) => {
          const artifact = [
            ...messages,
            ...(selectedExternalResult ? [selectedExternalResult] : []),
          ]
            .flatMap((message) => (message.kind === 'tool' ? (message.artifacts ?? []) : []))
            .find((one) => one.artifactId === id)
          if (artifact?.media === 'video') return null
          const fetched = [...messages, ...(selectedExternalResult ? [selectedExternalResult] : [])]
            .flatMap((message) =>
              message.kind === 'tool'
                ? (message.fetchedImages ?? []).map((image, index) => ({
                    id: fetchedCanvasId(message.toolCallId, index),
                    image,
                  }))
                : [],
            )
            .find((one) => one.id === id)
          const source = artifact
            ? await previewArtifactBitmap(artifact).catch(() => null)
            : fetched
              ? await resolveMediaSource(
                  `aip-media:${fetched.image.imageId}`,
                  'original',
                  true,
                ).catch(() => null)
              : null
          const available =
            source ??
            (await agentCanvasSink()
              ?.thumbnail(id, 3)
              .catch(() => null))
          if (!available) return null
          if (available.startsWith('data:')) return available
          const blob = await fetch(available)
            .then((response) => response.blob())
            .catch(() => null)
          if (!blob) return null
          return await new Promise<string | null>((resolve) => {
            const reader = new FileReader()
            reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
            reader.onerror = () => resolve(null)
            reader.readAsDataURL(blob)
          })
        }),
      )
      if (dataUrls.some((one) => !one)) return false
      const opened = targetId
        ? await useAgentStore.getState().selectProject(targetId)
        : await useAgentStore.getState().createProject(undefined, false, 'canvas', project?.id)
      if (!opened) return false
      const groupId = selected.length > 1 ? crypto.randomUUID() : undefined
      useStore
        .getState()
        .queueCanvasImages(
          dataUrls
            .filter((one): one is string => Boolean(one))
            .map((dataUrl) => ({ dataUrl, groupId })),
        )
      setSelectedResultId(null)
      setHandoffIds(null)
      setProjectView('canvas')
      return true
    } catch {
      return false
    }
  }
  const openCanvas = (selectedIds?: readonly string[]) => {
    if (projectView === 'chat' && (!project || projectExperience(project) === 'chat')) {
      setHandoffIds(selectedIds ?? [])
      return
    }
    setProjectView('canvas')
    if (selectedIds?.length) {
      focusedResult.current = latestResult?.id ?? null
      const focus = () => requestAnimationFrame(() => agentCanvasSink()?.focus(selectedIds))
      if (selectedIds.every((id) => agentCanvasSink()?.has(id))) focus()
      else {
        const owner = [
          ...useAgentStore.getState().messages,
          ...(selectedExternalResult ? [selectedExternalResult] : []),
        ].find(
          (message) =>
            message.kind === 'tool' &&
            (message.artifacts?.some((artifact) => selectedIds.includes(artifact.artifactId)) ||
              message.fetchedImages?.some((_, index) =>
                selectedIds.includes(fetchedCanvasId(message.toolCallId, index)),
              )),
        )
        if (owner)
          void useAgentStore
            .getState()
            .placeOnCanvas(owner.id)
            .then(() => {
              focus()
            })
        else focus()
      }
      return
    }
  }
  useEffect(() => {
    if (
      !hasAgent ||
      projectView !== 'canvas' ||
      !latestResult ||
      latestResult.delivery === undefined ||
      latestResult.delivery === 'pending' ||
      focusedResult.current === latestResult.id ||
      !agentCanvasSink()
    )
      return
    focusedResult.current = latestResult.id
    const ids =
      latestResult.artifacts?.map((artifact) => artifact.artifactId) ??
      latestResult.fetchedImages?.map((_, index) =>
        fetchedCanvasId(latestResult.toolCallId, index),
      ) ??
      []
    const focus = () => requestAnimationFrame(() => agentCanvasSink()?.focus(ids))
    if (ids.every((id) => agentCanvasSink()?.has(id))) focus()
    else void useAgentStore.getState().placeOnCanvas(latestResult.id).then(focus)
  }, [hasAgent, projectView, latestResult?.id, latestResult?.delivery])
  useEffect(() => {
    if (project) setProjectView(projectExperience(project))
  }, [project?.id, project?.experience])
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
    if (!hasAgent) return
    void useAgentStore.getState().load()
  }, [hasAgent, workspace])
  const { loading, loadFailed, saveFailed } = useSyncExternalStore(
    workspace.subscribe,
    workspace.getSnapshot,
  )
  useEffect(() => {
    if (!import.meta.env.DEV) return
    ;(window as unknown as { __canvasEditor?: CanvasEditor }).__canvasEditor = editor
  }, [editor])

  useEffect(() => workspace.fitInitialView(), [workspace, loading])

  // 画布已经开着时也可能有图送进来（素材库、灯箱里的「生成视频」），所以跟着队列长度重跑。
  const pendingImages = useStore((state) => state.pendingCanvasImages.length)
  useEffect(() => {
    if (pendingImages > 0) workspace.placePendingImages()
  }, [workspace, loading, loadFailed, pendingImages])
  return (
    <div
      className="studio-shell fixed bottom-0 right-0 z-30"
      style={{ top: HEADER_OFFSET, left: 'var(--app-sidebar-width)' }}
    >
      {showWelcome && !mobile && !loading && !loadFailed && !hasAgent ? (
        <ProjectWelcome workspace={workspace} />
      ) : (
        <>
          {hasAgent && (
            <div
              className={`studio-project-viewbar ${projectView === 'chat' ? 'studio-project-viewbar--chat' : ''} ${(sidebarExpanded ?? projectView === 'chat') ? 'studio-project-viewbar--with-sidebar' : ''}`}
            >
              <button
                type="button"
                onClick={() => useStore.getState().setAppMode('image')}
                aria-label={t('workspace.backHome')}
                title={t('workspace.backHome')}
                className="grid h-9 w-9 shrink-0 place-items-center"
              >
                <img src="/brand/muvloom-mark.svg" alt="" className="h-7 w-7" />
              </button>
              {!(sidebarExpanded ?? projectView === 'chat') && (
                <button
                  type="button"
                  onClick={() => useStore.getState().toggleSidebar()}
                  aria-label={tShell('header.nav')}
                  className="hidden h-9 w-9 shrink-0 place-items-center rounded-xl text-muted-foreground hover:bg-card hover:text-foreground md:grid"
                >
                  <PanelLeftOpen size={16} />
                </button>
              )}
              <ProjectNavigation />
              {projectView === 'canvas' && project?.sourceProjectId && (
                <button
                  type="button"
                  className="studio-source-chat-link"
                  onClick={() => {
                    if (project.sourceProjectId)
                      void useAgentStore.getState().selectProject(project.sourceProjectId)
                  }}
                >
                  <ArrowLeft size={15} aria-hidden="true" />
                  {t('workspace.sourceChat')}
                </button>
              )}
              {projectView === 'chat' && (
                <>
                  {productionEnabled && (
                    <button
                      type="button"
                      className="studio-assets-trigger"
                      aria-pressed={productionOpen}
                      title={tProduction('entry')}
                      onClick={() => {
                        const next = !productionOpen
                        setProductionOpen(next)
                        safeLocalStorage.setItem(productionViewKey, String(next))
                        if (next) {
                          useAgentStore.getState().setMode('video')
                          setSelectedResultId(null)
                        }
                      }}
                    >
                      <Clapperboard size={17} />
                      <span className="ml-1 text-xs">{tProduction('entry')}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="studio-assets-trigger studio-search-trigger"
                    aria-label="搜索当前对话"
                    title="搜索当前对话"
                    onClick={() => setSearchOpen(true)}
                  >
                    <Search size={18} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="studio-assets-trigger"
                    aria-label={t('workspace.assets')}
                    title={t('workspace.assets')}
                    onClick={() => setAssetDrawerOpen(true)}
                  >
                    <FolderOpen size={18} aria-hidden="true" />
                  </button>
                </>
              )}
            </div>
          )}
          <div
            className="studio-layout"
            data-production-open={productionVisible}
            data-project-view={hasAgent ? projectView : undefined}
            data-mobile-view={projectView}
            inert={loading || loadFailed}
          >
            {!hasAgent && (
              <div
                className="studio-mobile-switch"
                role="group"
                aria-label={t('mobileSwitch.aria')}
              >
                <button
                  type="button"
                  aria-pressed={projectView === 'chat'}
                  onClick={() => setProjectView('chat')}
                >
                  {t('mobileSwitch.chat')}
                </button>
                <button
                  type="button"
                  aria-pressed={projectView === 'canvas'}
                  onClick={() => setProjectView('canvas')}
                >
                  {t('mobileSwitch.canvas')}
                </button>
              </div>
            )}
            {/* 直接画布仍沿用原来的项目顶行；Agent 项目共用上方的双视图导航。 */}
            {open || mobile || (hasAgent && projectView === 'chat') ? (
              <div
                className={`studio-chat-column ${hasAgent && projectView === 'chat' ? 'studio-chat-column--page' : ''}`}
              >
                {!hasAgent && (
                  <div className="studio-canvas-topbar">
                    <button
                      type="button"
                      onClick={() => useStore.getState().setAppMode('image')}
                      aria-label={t('workspace.backHome')}
                      title={t('workspace.backHome')}
                      className="grid h-9 w-8 shrink-0 place-items-center"
                    >
                      <img src="/brand/muvloom-mark.svg" alt="" className="h-7 w-7" />
                    </button>
                    {!(sidebarExpanded ?? projectView === 'chat') && (
                      <button
                        type="button"
                        onClick={() => useStore.getState().toggleSidebar()}
                        aria-label={tShell('header.nav')}
                        className="hidden h-9 w-9 shrink-0 place-items-center rounded-xl text-muted-foreground hover:bg-card hover:text-foreground md:grid"
                      >
                        <PanelLeftOpen size={16} />
                      </button>
                    )}
                    <ProjectNavigation />
                  </div>
                )}
                {hasAgent ? (
                  productionVisible ? (
                    <ProductionWorkspace
                      conversationId={conversationId}
                      refreshKey={messages
                        .filter(
                          (message) =>
                            message.kind === 'tool' &&
                            (message.toolName === 'proposeProductionEdit' ||
                              message.toolName === 'proposeProductionAssets' ||
                              message.toolName === 'writeProduction' ||
                              message.toolName === 'readProduction'),
                        )
                        .map(
                          (message) =>
                            `${message.id}:${message.kind === 'tool' ? message.status : ''}`,
                        )
                        .join(',')}
                    >
                      <AgentPanel
                        doc={doc}
                        editor={editor}
                        mobile={mobile}
                        presentation="page"
                        searchOpen={searchOpen}
                        onCloseSearch={() => setSearchOpen(false)}
                        onPreviewResult={previewResult}
                        onPreviewProduction={previewProduction}
                        productionMode
                      />
                    </ProductionWorkspace>
                  ) : (
                    <AgentPanel
                      doc={doc}
                      editor={editor}
                      mobile={mobile}
                      presentation={projectView === 'chat' ? 'page' : 'side'}
                      searchOpen={searchOpen && projectView === 'chat'}
                      onCloseSearch={() => setSearchOpen(false)}
                      onViewCanvas={projectView === 'chat' ? undefined : openCanvas}
                      onPreviewResult={projectView === 'chat' ? previewResult : undefined}
                      onPreviewProduction={previewProduction}
                    />
                  )
                ) : (
                  <aside
                    className="studio-sidebar studio-sidebar--direct"
                    style={{ width: 380 }}
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
                        <svg
                          viewBox="0 0 16 16"
                          className="h-3.5 w-3.5"
                          fill="none"
                          aria-hidden="true"
                        >
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
                )}
              </div>
            ) : (
              /* 收起后只留一颗胶囊：窄栏会压住左侧画布工具条，也没给用户任何信息。 */
              <button
                type="button"
                className="studio-open-chat"
                onClick={() => setOpen(true)}
                title={t('sidebar.openChat')}
              >
                <img src="/brand/muvloom-mark.svg" alt="" className="h-7 w-7" />
                {t('sidebar.openChat')}
                <svg
                  viewBox="0 0 16 16"
                  className="h-3.5 w-3.5 opacity-70"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M4 10l4-4 4 4"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            )}
            {selectedResultId && activeResult && projectView === 'chat' && !productionVisible && (
              <AgentArtifactPane
                message={activeResult}
                selectedId={selectedArtifactId}
                onSelect={setSelectedArtifactId}
                onClose={() => {
                  setSelectedResultId(null)
                  setSelectedExternalResult(null)
                }}
                onViewCanvas={projectView === 'chat' ? undefined : openCanvas}
              />
            )}
            {assetDrawerOpen && projectView === 'chat' && (
              <AgentAssetDrawer
                messages={messages}
                onClose={() => setAssetDrawerOpen(false)}
                onPreview={previewAsset}
              />
            )}
            {handoffIds && (
              <AgentCanvasHandoffDialog
                count={handoffIds.length}
                projects={useCanvasProjectStore.getState().projects}
                onChoose={completeHandoff}
                onClose={() => {
                  setHandoffIds(null)
                }}
              />
            )}
            <section
              className="studio-canvas"
              aria-label={t('workspace.canvasAria')}
              inert={hasAgent && projectView !== 'canvas'}
            >
              {!loading && !loadFailed && <KonvaCanvas editor={editor} />}
              <PlaceholderOverlay editor={editor} />
              <CanvasVideoOverlay editor={editor} />
              <CanvasVideoToolbar editor={editor} />
              <CanvasImageToolbar editor={editor} />
              <InpaintMaskLayer editor={editor} />
              <CanvasRectEditLayer editor={editor} />
              <TimelineEditorHost editor={editor} />
              <FilmExportStatus />
              <CanvasToolbar
                doc={doc}
                onFitContent={() =>
                  editor.scrollToElements(
                    doc.elements.map((one) => one.id),
                    false,
                  )
                }
                onImportImages={() => fileInput.current?.click()}
                onImportFolder={() => folderInput.current?.click()}
              />
              <CanvasBatchBar editor={editor} />
              {hasAgent && projectView === 'canvas' && <AgentResultShelf doc={doc} />}
              <StylePanel doc={doc} />
              {saveFailed && (
                <div
                  role="alert"
                  className="absolute right-4 top-16 z-[410] max-w-xs rounded-xl border border-warning/40 bg-muted p-3 text-xs text-warning shadow-lg md:top-[var(--studio-account-cluster-clearance)]"
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
                  <img src="/brand/muvloom-mark.svg" alt="" />
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
                  importFiles(files)
                }}
              />
              <input
                ref={folderInput}
                type="file"
                {...{ webkitdirectory: '' }}
                multiple
                className="hidden"
                aria-label={t('import.folder')}
                onChange={(event) => {
                  const { files } = filesFromFolderInput(event.currentTarget.files)
                  event.currentTarget.value = ''
                  importFiles(files)
                }}
              />
            </section>
          </div>
        </>
      )}
      {loadFailed ? (
        <div role="alert" className="studio-canvas-status">
          <div>
            <p>{t('loadError.message')}</p>
            <button type="button" className="mt-2 underline" onClick={workspace.retryLoad}>
              {t('loadError.retry')}
            </button>
          </div>
        </div>
      ) : (
        loading && <CanvasLoading label={t('loading.restoring')} />
      )}
    </div>
  )
}
