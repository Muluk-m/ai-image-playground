import type { AgentSkillSummary } from '@image-playground/shared'
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { ErrorState } from '../../../components/assistant-ui/elements/error-state'
import SearchField from '../../../components/patterns/SearchField'
import SegmentedTabs from '../../../components/patterns/SegmentedTabs'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useImageDropZone } from '../../../hooks/useImageDropZone'
import { useTranslation } from '../../../i18n'
import type { CanvasDoc } from '../../canvas/lib/canvasDoc'
import type { CanvasEditor } from '../../canvas/lib/editor'
import ProductionResultCard from '../../production/components/ProductionResultCard'
import type { ProductionPane } from '../../production/lib/productionContext'
import {
  ACTIVE_TAB,
  CARD,
  CARD_TITLE,
  IDLE_TAB,
  JUMP_TO_LATEST,
  PANEL_MAX_WIDTH_RATIO,
  TAB,
} from '../agentStyles'
import { useActiveAgentSurface } from '../lib/activeAgentSurface'
import { groupPanelMessages } from '../lib/activityTrail'
import { attachFilesToComposer } from '../lib/attachments'
import { answerableClarificationId } from '../lib/panelMessages'
import { usePlanCardState } from '../lib/planCardState'
import { isProductionDraft } from '../lib/promptDraft'
import { useAgentSkills } from '../lib/useAgentSkills'
import { agentPanelPresent } from '../panelLayout'
import { useAgentStore } from '../store'
import type { AgentPanelMessage, AgentToolMessage } from '../types'
import AgentActivity from './AgentActivity'
import AgentActivityTrail from './AgentActivityTrail'
import AgentClarification from './AgentClarification'
import AgentComposer from './AgentComposer'
import AgentConnectionHint from './AgentConnectionHint'
import AgentCopyDiagnostic from './AgentCopyDiagnostic'
import AgentCreations from './AgentCreations'
import AgentFollowUpChips from './AgentFollowUpChips'
import AgentGenerationPlan from './AgentGenerationPlan'
import AgentHistoryStatus from './AgentHistoryStatus'
import AgentImageActionStepView from './AgentImageActionStep'
import AgentMessageQueue from './AgentMessageQueue'
import AgentReply from './AgentReply'
import { AgentReplyImagesProvider } from './AgentReplyImage'
import AgentSaveCard from './AgentSaveCard'
import AgentSuggestions from './AgentSuggestions'
import AgentToolCard, { AgentImageRun } from './AgentToolCard'
import AgentTurnCost from './AgentTurnCost'
import AgentUserMessage from './AgentUserMessage'
import CanvasAgentWelcome from './CanvasAgentWelcome'

const TABS = [
  { id: 'chat', labelKey: 'label.chat' },
  { id: 'layers', labelKey: 'label.layers' },
] as const

function CollapsedButton({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation('agent')
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onOpen}
      className="studio-open-chat h-12 w-auto gap-2.5 rounded-full border border-border bg-card pl-2 pr-4 text-sm font-medium text-foreground hover:bg-muted"
    >
      {t('panel.expand')}
    </Button>
  )
}

function renderMessage(
  message: AgentPanelMessage,
  answerableId: string | null,
  skills: readonly AgentSkillSummary[],
  onViewCanvas?: (objectIds?: readonly string[]) => void,
  onPreviewResult?: (messageId: string, objectId?: string, previewSource?: string) => void,
  onPreviewProduction?: (pane?: ProductionPane) => void,
  cached = false,
) {
  if (cached && message.kind === 'tool' && !showsImageTiles(message))
    return (
      <section className={CARD} aria-label={message.title}>
        <h3 className={CARD_TITLE}>{message.title}</h3>
        {message.prompt && <p className="whitespace-pre-wrap text-xs">{message.prompt}</p>}
        {message.message && <p className="whitespace-pre-wrap text-xs">{message.message}</p>}
      </section>
    )
  if (cached && message.kind === 'clarification')
    return (
      <section className={CARD} aria-label={message.question}>
        <h3 className={CARD_TITLE}>{message.question}</h3>
        <ul className="list-inside list-disc text-xs">
          {message.options.map((option, index) => (
            <li key={index}>{option}</li>
          ))}
        </ul>
      </section>
    )
  if (message.kind === 'tool') {
    if (
      (message.toolName === 'writeProduction' || message.toolName === 'proposeStoryboard') &&
      message.status === 'succeeded' &&
      onPreviewProduction
    )
      return (
        <ProductionResultCard
          title={message.title}
          pane={message.toolName === 'proposeStoryboard' ? 'storyboard' : 'script'}
          onOpen={() =>
            onPreviewProduction(message.toolName === 'proposeStoryboard' ? 'storyboard' : 'script')
          }
        />
      )
    // 保存卡片是一张可操作的卡，不是一件产出：它有自己的样子与自己的那一下。
    if (message.saveCard) return <AgentSaveCard card={message.saveCard} message={message} />
    // 读技能这类过程步已经被 groupPanelMessages 折进活动轨；走到这里的只剩带产物 / 会失败的调用。
    return (
      <AgentToolCard
        message={message}
        onPreviewProduction={onPreviewProduction}
        onViewCanvas={onViewCanvas}
        onPreviewResult={onPreviewResult}
      />
    )
  }
  if (message.kind === 'imageAction') return <AgentImageActionStepView message={message} />
  if (message.kind === 'clarification') {
    return <AgentClarification message={message} answered={message.id !== answerableId} />
  }
  if (message.role === 'user') return <AgentUserMessage message={message} skills={skills} />
  return <AgentReply text={message.text} streaming={message.streaming} />
}

/** 连续取回的单张网图属于同一批素材，在对话里共用一条缩略图带。 */
function fetchedImageRuns(messages: readonly AgentPanelMessage[]) {
  const starts = new Map<number, readonly AgentToolMessage[]>()
  const absorbed = new Set<number>()
  for (let index = 0; index < messages.length; ) {
    const first = messages[index]
    if (
      first?.kind !== 'tool' ||
      first.toolName !== 'fetchImage' ||
      first.status !== 'succeeded' ||
      first.delivery === 'pending' ||
      first.fetchedImages?.length !== 1
    ) {
      index += 1
      continue
    }
    const start = index
    const run: AgentToolMessage[] = []
    while (index < messages.length) {
      const message = messages[index]
      if (
        message?.kind !== 'tool' ||
        message.turnId !== first.turnId ||
        message.toolName !== 'fetchImage' ||
        message.status !== 'succeeded' ||
        message.delivery === 'pending' ||
        message.fetchedImages?.length !== 1
      )
        break
      run.push(message)
      absorbed.add(index)
      index += 1
    }
    starts.set(start, run)
  }
  return { starts, absorbed }
}

function isImagePlanDraft(message: AgentPanelMessage): message is AgentToolMessage {
  return (
    message.kind === 'tool' &&
    message.status === 'awaiting_confirmation' &&
    (message.toolName === 'generateImage' || message.toolName === 'editImage') &&
    !isProductionDraft(message)
  )
}

function isImageOutput(message: AgentPanelMessage): message is AgentToolMessage {
  if (message.kind !== 'tool') return false
  if (message.toolName !== 'generateImage' && message.toolName !== 'editImage') return false
  if (message.status === 'awaiting_confirmation' || message.canvasRun || message.saveCard)
    return false
  if (message.status === 'failed') return false
  return (
    message.status === 'running' ||
    message.status === 'submitted' ||
    message.status === 'queued' ||
    message.status === 'succeeded'
  )
}

// 非类型守卫版本：取反时不能把 tool 消息收窄成 never。
function showsImageTiles(message: AgentToolMessage): boolean {
  return isImageOutput(message)
}

/** 同一轮里连续的同类图片消息收成一张卡或一行图。 */
function consecutiveImageRuns(
  messages: readonly AgentPanelMessage[],
  accept: (message: AgentPanelMessage) => message is AgentToolMessage,
  minLength: number,
) {
  const starts = new Map<number, readonly AgentToolMessage[]>()
  const absorbed = new Set<number>()
  for (let index = 0; index < messages.length; ) {
    const first = messages[index]
    if (!first || !accept(first)) {
      index += 1
      continue
    }
    const start = index
    const run: AgentToolMessage[] = []
    while (index < messages.length) {
      const message = messages[index]
      if (!message || !accept(message) || message.turnId !== first.turnId) break
      run.push(message)
      absorbed.add(index)
      index += 1
    }
    if (run.length >= minLength) starts.set(start, run)
    else absorbed.delete(start)
  }
  return { starts, absorbed }
}

/**
 * 计划卡的 key 锚在这段计划的最后一张稿上，不锚第一张，也不按段序编号。
 *
 * 「全部生成」自上而下逐张确认：前面的稿成交后就不再是待确认稿，计划从下一张起算。key 若取
 * 第一张稿的 id，这一刻整张计划卡就被卸下重挂——还在跑的确认循环把后面那张被拒（例如积分不足）
 * 的结果写进一个已经不在的组件，用户什么也看不见。按「本轮第几段」编号也不行：同一轮里被别的
 * 消息隔开的前一段计划确认完消失后，后一段的序号跟着变，同样会被重挂。最后一张稿要等整段都
 * 提交完才离开，期间这段计划的 key 不变，也不受其他段增减影响。
 */
function planRunKeys(
  starts: ReadonlyMap<number, readonly AgentToolMessage[]>,
): Map<number, string> {
  const keys = new Map<number, string>()
  for (const [index, run] of starts) keys.set(index, `plan:${run[run.length - 1]?.id ?? index}`)
  return keys
}

export default function AgentPanel({
  doc,
  editor,
  mobile = false,
  onViewCanvas,
  onPreviewResult,
  presentation = 'side',
  dock = 'left',
  searchOpen = false,
  onCloseSearch,
  onPreviewProduction,
  productionMode = false,
}: {
  doc: CanvasDoc
  editor: CanvasEditor
  mobile?: boolean
  onViewCanvas?: (objectIds?: readonly string[]) => void
  onPreviewResult?: (messageId: string, objectId?: string, previewSource?: string) => void
  presentation?: 'page' | 'side'
  dock?: 'left' | 'right'
  searchOpen?: boolean
  onCloseSearch?: () => void
  onPreviewProduction?: (pane?: ProductionPane) => void
  productionMode?: boolean
}) {
  const { t } = useTranslation(['agent', 'errors'])
  const open = useAgentStore((state) => state.open)
  const tab = useAgentStore((state) => state.tab)
  const messages = useAgentStore((state) => state.messages)
  const turns = useAgentStore((state) => state.turns)
  const surface = useActiveAgentSurface()
  const imageSkills = useAgentSkills('image', surface)
  const videoSkills = useAgentSkills('video', surface)
  const skills = useMemo(() => [...imageSkills, ...videoSkills], [imageSkills, videoSkills])
  const error = useAgentStore((state) => state.error)
  const returnedMessagesError = useAgentStore((state) => state.returnedMessagesError)
  const returnedMessagesPending = useAgentStore((state) => state.returnedMessagesPending)
  const errorDiagnostic = useAgentStore((state) => state.errorDiagnostic)
  const diagnosticConversationId = useAgentStore((state) => state.conversationId)
  const panelWidth = useAgentStore((state) => state.panelWidth)
  const { setOpen, setTab, load, setPanelWidth } = useAgentStore.getState()
  useEffect(() => {
    if (presentation === 'page' && tab === 'layers') setTab('chat')
  }, [presentation, tab, setTab])
  const historyLoading = useAgentStore((state) => state.historyLoading)
  const historyCached = useAgentStore((state) => state.historyCached)
  const historyFailed = useAgentStore((state) => state.historyFailed)
  const logRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (dock !== 'right' || presentation !== 'side' || !open || !panelRef.current) return
    const panel = panelRef.current
    const measure = () =>
      document.documentElement.style.setProperty(
        '--studio-canvas-chat-width',
        `${panel.offsetWidth}px`,
      )
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(panel)
    return () => {
      observer?.disconnect()
      document.documentElement.style.removeProperty('--studio-canvas-chat-width')
    }
  }, [dock, presentation, open])
  const followLatest = useRef(true)
  /** 离开底部期间来了新内容：浮出「有新消息」，回到底部即收起。 */
  const [unseen, setUnseen] = useState(false)
  const [search, setSearch] = useState('')
  // 每次定位都换一个序号：同一步被点第二次（中间被用户收起过）也要重新展开。
  const [located, setLocated] = useState<{ id: string; seq: number } | null>(null)
  const searchResults = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    if (!query) return []
    return messages.filter((message) => {
      const text =
        message.kind === 'text'
          ? message.text
          : message.kind === 'tool'
            ? `${message.title} ${message.prompt ?? ''}`
            : message.kind === 'imageAction'
              ? t('imageAction.removeBackground')
              : message.question
      return text.toLocaleLowerCase().includes(query)
    })
  }, [messages, search, t])
  const locateMessage = (id: string) => {
    setLocated((prev) => ({ id, seq: (prev?.seq ?? 0) + 1 }))
    requestAnimationFrame(() => {
      const target = Array.from(
        logRef.current?.querySelectorAll<HTMLElement>('[data-agent-message-id]') ?? [],
      ).find((one) => one.dataset.agentMessageId === id)
      target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
    followLatest.current = false
  }
  const conversationId = useAgentStore((state) => state.conversationId)
  // 计划卡的勾选、确认中与停因按稿 id 记在面板上、按会话隔离：卡片随逐张提交或别处确认拆段、
  // 换 key 重挂时状态不丢，还在跑的确认循环也写得回来；稿成交或被移除后对应状态随即丢弃。
  const planDraftIds = useMemo(
    () => new Set(messages.filter(isImagePlanDraft).map((message) => message.id)),
    [messages],
  )
  const planCard = usePlanCardState(conversationId, planDraftIds)
  useLayoutEffect(() => {
    followLatest.current = true
    setUnseen(false)
  }, [conversationId, open, tab])
  // 文件拖到对话记录上也算数：草稿归输入框管，这里只把文件递过去。
  const { dragging, dropZoneProps } = useImageDropZone((files) => {
    attachFilesToComposer(files)
  })

  useEffect(() => {
    void load()
  }, [load])

  /** 上一次看到的末尾：只有末尾长出新东西才算「有新消息」，改旧卡片的交付状态、收尾一轮都不算。 */
  const lastTail = useRef<string | null>(null)
  const lastTailId = useRef<string | null>(null)
  useLayoutEffect(() => {
    const log = logRef.current
    if (!log) return
    const last = messages[messages.length - 1] as AgentPanelMessage | undefined
    const tail = last ? tailSignature(last) : null
    const grew = tail !== null && tail !== lastTail.current
    // 用户自己发出的消息不是「没看到的内容」：发送即回到最新，接着跟随回复。
    if (grew && last?.kind === 'text' && last.role === 'user' && last.id !== lastTailId.current) {
      followLatest.current = true
    }
    lastTail.current = tail
    lastTailId.current = last?.id ?? null
    if (followLatest.current) {
      log.scrollTop = log.scrollHeight
      setUnseen(false)
    } else if (grew) setUnseen(true)
  }, [messages, open, tab, conversationId])

  useEffect(() => {
    const log = logRef.current
    if (!log || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (followLatest.current) log.scrollTop = log.scrollHeight
    })
    for (const child of log.children) observer.observe(child)
    return () => observer.disconnect()
  }, [messages, turns, tab, conversationId])

  const jumpToLatest = () => {
    const log = logRef.current
    if (log) log.scrollTop = log.scrollHeight
    followLatest.current = true
    setUnseen(false)
  }

  /** 从实际显示宽度开始拖动，避免布局限宽后反向拖动出现空行程。 */
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const handle = event.currentTarget
    const originX = event.clientX
    const originWidth = handle.parentElement?.getBoundingClientRect().width || panelWidth
    const maxWidth =
      dock === 'right'
        ? (handle.closest('.studio-layout')?.clientWidth ?? window.innerWidth) *
          PANEL_MAX_WIDTH_RATIO
        : Number.POSITIVE_INFINITY
    handle.setPointerCapture(event.pointerId)
    const onMove = (move: PointerEvent) =>
      setPanelWidth(
        Math.min(maxWidth, originWidth + (move.clientX - originX) * (dock === 'right' ? -1 : 1)),
      )
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      handle.removeEventListener('pointercancel', onUp)
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
    handle.addEventListener('pointercancel', onUp)
  }

  if (!agentPanelPresent()) return null
  if (!open && !mobile && presentation === 'side')
    return <CollapsedButton onOpen={() => setOpen(true)} />

  const answerableId = answerableClarificationId(messages)
  // 页脚跟在本轮最后一条消息后面。重试记录自成一轮、按时间追加在对话末尾，可能夹在一轮的
  // 消息中间，所以按「这一轮的最后一条」认，而不只看下一条换没换轮。
  const lastOfTurn = new Map(messages.map((message, index) => [message.turnId, index]))
  const jobsByTurn = new Map<string, AgentToolMessage[]>()
  for (const message of messages) {
    if (message.kind !== 'tool' || !message.job) continue
    const jobs = jobsByTurn.get(message.turnId) ?? []
    jobs.push(message)
    jobsByTurn.set(message.turnId, jobs)
  }
  // 连续的过程步（读画布、看图、读技能）折成一条固定高度的活动轨，不再一步一张空卡。
  const grouping = groupPanelMessages(messages)
  const fetchedRuns = presentation === 'page' && onPreviewResult ? fetchedImageRuns(messages) : null
  const planRuns = consecutiveImageRuns(messages, isImagePlanDraft, 1)
  const planKeys = planRunKeys(planRuns.starts)
  const imageRuns = consecutiveImageRuns(messages, isImageOutput, 2)

  return (
    <AgentReplyImagesProvider messages={messages} onPreview={onPreviewResult}>
      <div
        ref={panelRef}
        aria-label={t('panel.aria')}
        data-dock={dock}
        style={presentation === 'side' ? { width: panelWidth } : undefined}
        className={`studio-sidebar ${presentation === 'page' ? 'studio-sidebar--page' : ''}`}
      >
        {presentation === 'side' && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t('panel.resizeAria')}
            title={t('panel.resizeTitle')}
            onPointerDown={startResize}
            className={`absolute ${dock === 'right' ? '-left-1.5' : '-right-1.5'} top-6 bottom-6 z-10 hidden md:block w-3 cursor-col-resize touch-none rounded-full transition-colors hover:bg-primary/40 active:bg-primary/60`}
          />
        )}
        {presentation === 'side' && (
          <div className="studio-agent-tabs flex shrink-0 items-center justify-between gap-3 px-4 pb-3 pt-2">
            {dock === 'right' ? (
              <SegmentedTabs
                label={t('panel.aria')}
                tabs={TABS.map((one) => ({ value: one.id, label: t(one.labelKey) }))}
                value={tab === 'layers' ? 'layers' : 'chat'}
                onChange={setTab}
              />
            ) : (
              <div className="flex items-center gap-1.5">
                {TABS.map((one) => (
                  <Button
                    key={one.id}
                    type="button"
                    variant="ghost"
                    onClick={() => setTab(one.id)}
                    className={`${TAB} h-auto font-normal ${(one.id === 'chat' ? tab !== 'layers' : tab === one.id) ? ACTIVE_TAB : IDLE_TAB}`}
                  >
                    {t(one.labelKey)}
                  </Button>
                ))}
              </div>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('panel.collapseAria')}
              title={t('panel.collapseAria')}
              className={`${dock === 'right' ? 'inline-flex' : 'hidden md:inline-flex'} h-7 w-7 shrink-0 rounded-lg text-muted-foreground`}
              onClick={() => setOpen(false)}
            >
              <Icon name={dock === 'right' ? 'minimize' : 'sidebar'} />
            </Button>
          </div>
        )}

        <AgentConnectionHint />

        {presentation === 'page' && searchOpen && (
          <div className="studio-conversation-search" role="dialog" aria-label={t('panel.search')}>
            <SearchField
              autoFocus
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('panel.search')}
              aria-label={t('panel.search')}
              className="h-8 min-w-0 max-w-none flex-1"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onCloseSearch}
              aria-label={t('panel.closeSearch')}
            >
              <Icon name="close" />
            </Button>
            {search.trim() && (
              <div className="studio-conversation-search-results" aria-live="polite">
                {searchResults.length ? (
                  searchResults.map((message) => (
                    <Button
                      key={message.id}
                      type="button"
                      variant="ghost"
                      onClick={() => locateMessage(message.id)}
                      className="h-auto w-full justify-start truncate rounded-md px-2 py-2 text-left text-xs font-normal hover:bg-muted"
                    >
                      {message.kind === 'text'
                        ? message.text
                        : message.kind === 'tool'
                          ? message.title
                          : message.kind === 'imageAction'
                            ? t('imageAction.removeBackground')
                            : message.question}
                    </Button>
                  ))
                ) : (
                  <p>{t('panel.noSearchResults')}</p>
                )}
              </div>
            )}
          </div>
        )}

        {tab === 'layers' ? (
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            <AgentCreations doc={doc} editor={editor} onSelect={onViewCanvas} />
          </div>
        ) : (
          <div className="relative flex min-h-0 flex-1 flex-col">
            <div
              ref={logRef}
              // 全站默认禁止选中文字（画布拖拽不能拖出一片高亮）；对话记录是要被复制的，放开。
              data-selectable-text
              aria-label={t('panel.logAria')}
              onScroll={(event) => {
                const log = event.currentTarget
                followLatest.current = log.scrollHeight - log.clientHeight - log.scrollTop <= 48
                if (followLatest.current) setUnseen(false)
              }}
              className={`studio-agent-log relative flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto overscroll-contain px-3 py-1 ${dragging ? 'rounded-xl outline-dashed outline-1 outline-ring/70' : ''}`}
              {...dropZoneProps}
            >
              <div
                className={
                  presentation === 'page'
                    ? 'studio-agent-log-content'
                    : `flex shrink-0 flex-col gap-2.5 ${dock === 'right' && messages.length === 0 ? 'min-h-full' : ''}`
                }
              >
                {messages.length === 0 &&
                  !historyLoading &&
                  !historyFailed &&
                  (dock === 'right' && presentation === 'side' ? (
                    <CanvasAgentWelcome skills={skills} />
                  ) : (
                    <div className="studio-chat-empty">
                      <h3>{t('panel.emptyTitle')}</h3>
                      <AgentSuggestions className="studio-suggestions" />
                    </div>
                  ))}
                {messages.map((message, index) => {
                  const planRun = planRuns.starts.get(index)
                  if (planRuns.absorbed.has(index) && !planRun) return null
                  if (planRun) {
                    const lastIndex = index + planRun.length - 1
                    const footer =
                      lastOfTurn.get(message.turnId) === lastIndex ? turns[message.turnId] : null
                    return (
                      <div
                        key={`${planKeys.get(index)}:${historyCached}`}
                        data-agent-message-id={message.id}
                        className="studio-agent-message-block"
                      >
                        <fieldset disabled={historyCached} className="contents">
                          <AgentGenerationPlan messages={planRun} plan={planCard} />
                        </fieldset>
                        {footer && !turnShowsImageReceipt(messages, message.turnId) && (
                          <AgentTurnCost footer={footer} jobs={jobsByTurn.get(message.turnId)} />
                        )}
                      </div>
                    )
                  }
                  const imageRun = imageRuns.starts.get(index)
                  if (imageRuns.absorbed.has(index) && !imageRun) return null
                  if (imageRun) {
                    const lastIndex = index + imageRun.length - 1
                    const footer =
                      lastOfTurn.get(message.turnId) === lastIndex ? turns[message.turnId] : null
                    return (
                      <div
                        key={`${message.id}:${historyCached}`}
                        data-agent-message-id={message.id}
                        className="studio-agent-message-block"
                      >
                        <fieldset disabled={historyCached} className="contents">
                          <AgentImageRun
                            messages={imageRun}
                            onViewCanvas={onViewCanvas}
                            onPreviewResult={onPreviewResult}
                            onPreviewProduction={onPreviewProduction}
                          />
                        </fieldset>
                        {footer && !turnShowsImageReceipt(messages, message.turnId) && (
                          <AgentTurnCost footer={footer} jobs={jobsByTurn.get(message.turnId)} />
                        )}
                      </div>
                    )
                  }
                  const fetchedRun = fetchedRuns?.starts.get(index)
                  if (fetchedRuns?.absorbed.has(index) && !fetchedRun) return null
                  if (fetchedRun) {
                    const lastIndex = index + fetchedRun.length - 1
                    const footer =
                      lastOfTurn.get(message.turnId) === lastIndex ? turns[message.turnId] : null
                    return (
                      <div
                        key={`${message.id}:${historyCached}`}
                        className="studio-agent-message-block"
                      >
                        <div className="studio-agent-fetched-strip">
                          {fetchedRun.map((image) => (
                            <div
                              key={image.id}
                              data-agent-message-id={image.id}
                              className="studio-agent-fetched-strip-item"
                            >
                              <fieldset disabled={historyCached} className="contents">
                                <AgentToolCard
                                  message={image}
                                  onViewCanvas={onViewCanvas}
                                  onPreviewResult={onPreviewResult}
                                  compactFetched
                                />
                              </fieldset>
                            </div>
                          ))}
                        </div>
                        {footer && !turnShowsImageReceipt(messages, message.turnId) && (
                          <AgentTurnCost footer={footer} jobs={jobsByTurn.get(message.turnId)} />
                        )}
                      </div>
                    )
                  }
                  const footer =
                    lastOfTurn.get(message.turnId) === index ? turns[message.turnId] : null
                  const trail = grouping.trails.get(index)
                  if (grouping.absorbed.has(index) && !trail && !footer) return null
                  // 历史里可能落下一条空的助手文本。它不显示内容，也不该留下块间距。
                  if (
                    message.kind === 'text' &&
                    message.role === 'assistant' &&
                    !message.streaming &&
                    !message.text.trim() &&
                    !trail &&
                    !footer
                  )
                    return null
                  return (
                    <div
                      key={message.kind === 'text' ? message.id : `${message.id}:${historyCached}`}
                      data-agent-message-id={message.id}
                      className="studio-agent-message-block"
                    >
                      {trail && (
                        <AgentActivityTrail
                          steps={trail.steps}
                          spent={trail.spent}
                          revealId={located?.id}
                          revealSeq={located?.seq}
                        />
                      )}
                      {!grouping.absorbed.has(index) &&
                        renderMessage(
                          message,
                          answerableId,
                          skills,
                          onViewCanvas,
                          onPreviewResult,
                          onPreviewProduction,
                          historyCached,
                        )}
                      {footer && !turnShowsImageReceipt(messages, message.turnId) && (
                        <AgentTurnCost footer={footer} jobs={jobsByTurn.get(message.turnId)} />
                      )}
                    </div>
                  )
                })}
                <AgentActivity />
                <AgentHistoryStatus />
                {presentation === 'page' && <AgentFollowUpChips />}
                {(error || returnedMessagesPending) && !historyFailed && (
                  <ErrorState
                    title={t('panel.errorTitle')}
                    detail={
                      returnedMessagesPending
                        ? t(`errors:agentQueue.${returnedMessagesError ?? 'fallback'}`)
                        : (error ?? undefined)
                    }
                    actions={
                      <>
                        {returnedMessagesPending && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void useAgentStore.getState().retryReturnedMessages()}
                          >
                            {t('draft.retryRestore')}
                          </Button>
                        )}
                        <AgentCopyDiagnostic
                          diagnostic={
                            errorDiagnostic ?? {
                              conversationId: diagnosticConversationId,
                              message: error,
                            }
                          }
                        />
                      </>
                    }
                  />
                )}
              </div>
            </div>
            {unseen && (
              <Button
                type="button"
                variant="ghost"
                onClick={jumpToLatest}
                className={`${JUMP_TO_LATEST} h-auto font-normal`}
              >
                <Icon name="chevronDown" />
                {t('panel.jumpToLatest')}
              </Button>
            )}
          </div>
        )}

        {tab === 'chat' && <AgentMessageQueue />}
        {tab === 'chat' && (
          <AgentComposer
            productionMode={productionMode}
            doc={doc}
            editor={editor}
            showLooks={presentation !== 'page' || messages.length === 0}
            showCanvasReferences={presentation !== 'page'}
            showFollowUpGhost={presentation !== 'page'}
          />
        )}
      </div>
    </AgentReplyImagesProvider>
  )
}

/** 这轮的生图结果自己写出耗时和积分，页脚不再重复一份。 */
function turnShowsImageReceipt(messages: readonly AgentPanelMessage[], turnId: string): boolean {
  return messages.some(
    (message) =>
      message.turnId === turnId &&
      message.kind === 'tool' &&
      (message.toolName === 'generateImage' || message.toolName === 'editImage') &&
      message.status === 'succeeded' &&
      Boolean(message.artifacts?.some((artifact) => artifact.media === 'image')),
  )
}

/** 末尾那条消息长到哪了：换了一条、文字变长、工具卡跑出结果都会变；交付状态与流式收尾不计入。 */
function tailSignature(message: AgentPanelMessage): string {
  if (message.kind === 'text') return `${message.id}:${message.text.length}`
  if (message.kind === 'tool') {
    return `${message.id}:${message.status}:${message.stage ?? ''}:${message.artifacts?.length ?? 0}:${message.message ?? ''}`
  }
  return message.id
}
