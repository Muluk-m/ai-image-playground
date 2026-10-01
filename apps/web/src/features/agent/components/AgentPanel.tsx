import type { AgentSkillSummary } from '@image-playground/shared'
import { ArrowDown, Search, X } from 'lucide-react'
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { ErrorState } from '../../../components/assistant-ui/elements/error-state'
import { Button } from '../../../components/ui/button'
import { useImageDropZone } from '../../../hooks/useImageDropZone'
import { useTranslation } from '../../../i18n'
import type { CanvasDoc } from '../../canvas/lib/canvasDoc'
import type { CanvasEditor } from '../../canvas/lib/editor'
import { ACTIVE_TAB, ICON_BUTTON, IDLE_TAB, JUMP_TO_LATEST, TAB } from '../agentStyles'
import { groupPanelMessages } from '../lib/activityTrail'
import { attachFilesToComposer } from '../lib/attachments'
import { answerableClarificationId } from '../lib/panelMessages'
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
import AgentHistoryStatus from './AgentHistoryStatus'
import AgentMessageQueue from './AgentMessageQueue'
import AgentPendingDrafts from './AgentPendingDrafts'
import AgentReply from './AgentReply'
import AgentSaveCard from './AgentSaveCard'
import AgentSuggestions from './AgentSuggestions'
import AgentToolCard from './AgentToolCard'
import AgentTurnCost from './AgentTurnCost'
import AgentUserMessage from './AgentUserMessage'

const TABS = [
  { id: 'chat', labelKey: 'label.chat' },
  { id: 'layers', labelKey: 'label.layers' },
] as const

function CollapsedButton({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation('agent')
  return (
    <button type="button" onClick={onOpen} className="studio-open-chat">
      {t('panel.expand')}
    </button>
  )
}

function renderMessage(
  message: AgentPanelMessage,
  answerableId: string | null,
  skills: readonly AgentSkillSummary[],
  onViewCanvas?: (objectIds?: readonly string[]) => void,
  onPreviewResult?: (messageId: string, objectId?: string) => void,
) {
  if (message.kind === 'tool') {
    // 保存卡片是一张可操作的卡，不是一件产出：它有自己的样子与自己的那一下。
    if (message.saveCard) return <AgentSaveCard card={message.saveCard} message={message} />
    // 读技能这类过程步已经被 groupPanelMessages 折进活动轨；走到这里的只剩带产物 / 会失败的调用。
    return (
      <AgentToolCard
        message={message}
        onViewCanvas={onViewCanvas}
        onPreviewResult={onPreviewResult}
      />
    )
  }
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

export default function AgentPanel({
  doc,
  editor,
  mobile = false,
  onViewCanvas,
  onPreviewResult,
  presentation = 'side',
  searchOpen = false,
  onCloseSearch,
}: {
  doc: CanvasDoc
  editor: CanvasEditor
  mobile?: boolean
  onViewCanvas?: (objectIds?: readonly string[]) => void
  onPreviewResult?: (messageId: string, objectId?: string) => void
  presentation?: 'page' | 'side'
  searchOpen?: boolean
  onCloseSearch?: () => void
}) {
  const { t } = useTranslation(['agent', 'errors'])
  const open = useAgentStore((state) => state.open)
  const tab = useAgentStore((state) => state.tab)
  const messages = useAgentStore((state) => state.messages)
  const turns = useAgentStore((state) => state.turns)
  const imageSkills = useAgentSkills('image')
  const videoSkills = useAgentSkills('video')
  const skills = useMemo(() => [...imageSkills, ...videoSkills], [imageSkills, videoSkills])
  const error = useAgentStore((state) => state.error)
  const returnedMessagesPending = useAgentStore((state) => state.returnedMessagesPending)
  const errorDiagnostic = useAgentStore((state) => state.errorDiagnostic)
  const diagnosticConversationId = useAgentStore((state) => state.conversationId)
  const panelWidth = useAgentStore((state) => state.panelWidth)
  const { setOpen, setTab, load, setPanelWidth } = useAgentStore.getState()
  useEffect(() => {
    if (presentation === 'page' && tab === 'layers') setTab('chat')
  }, [presentation, tab, setTab])
  const historyLoading = useAgentStore((state) => state.historyLoading)
  const historyFailed = useAgentStore((state) => state.historyFailed)
  const logRef = useRef<HTMLDivElement>(null)
  const followLatest = useRef(true)
  /** 离开底部期间来了新内容：浮出「有新消息」，回到底部即收起。 */
  const [unseen, setUnseen] = useState(false)
  const [search, setSearch] = useState('')
  const [locatedId, setLocatedId] = useState<string | null>(null)
  const searchResults = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    if (!query) return []
    return messages.filter((message) => {
      const text =
        message.kind === 'text'
          ? message.text
          : message.kind === 'tool'
            ? `${message.title} ${message.prompt ?? ''}`
            : message.question
      return text.toLocaleLowerCase().includes(query)
    })
  }, [messages, search])
  const locateMessage = (id: string) => {
    setLocatedId(id)
    requestAnimationFrame(() => {
      const target = Array.from(
        logRef.current?.querySelectorAll<HTMLElement>('[data-agent-message-id]') ?? [],
      ).find((one) => one.dataset.agentMessageId === id)
      target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
    followLatest.current = false
  }
  const conversationId = useAgentStore((state) => state.conversationId)
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

  /** 右缘拖宽：按下即捕获指针，宽度跟手，松开时的值已经在 store 里记住了。 */
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const handle = event.currentTarget
    const originX = event.clientX
    const originWidth = panelWidth
    handle.setPointerCapture(event.pointerId)
    const onMove = (move: PointerEvent) => setPanelWidth(originWidth + move.clientX - originX)
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

  return (
    <div
      aria-label={t('panel.aria')}
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
          className="absolute -right-1.5 top-6 bottom-6 z-10 hidden md:block w-3 cursor-col-resize touch-none rounded-full transition-colors hover:bg-primary/40 active:bg-primary/60"
        />
      )}
      {presentation === 'side' && (
        <div className="studio-agent-tabs flex shrink-0 items-center justify-between gap-3 px-4 pb-3 pt-2">
          <div className="flex items-center gap-1.5">
            {TABS.map((one) => (
              <button
                key={one.id}
                type="button"
                onClick={() => setTab(one.id)}
                className={`${TAB} ${(one.id === 'chat' ? tab !== 'layers' : tab === one.id) ? ACTIVE_TAB : IDLE_TAB}`}
              >
                {t(one.labelKey)}
              </button>
            ))}
          </div>
          <button
            type="button"
            aria-label={t('panel.collapseAria')}
            className={`${ICON_BUTTON} hidden md:inline-flex`}
            onClick={() => setOpen(false)}
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
      )}

      <AgentConnectionHint />

      {presentation === 'page' && searchOpen && (
        <div className="studio-conversation-search" role="dialog" aria-label={t('panel.search')}>
          <label>
            <Search size={17} aria-hidden="true" />
            <input
              autoFocus
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('panel.search')}
            />
          </label>
          <button type="button" onClick={onCloseSearch} aria-label={t('panel.closeSearch')}>
            <X size={17} />
          </button>
          {search.trim() && (
            <div className="studio-conversation-search-results" aria-live="polite">
              {searchResults.length ? (
                searchResults.map((message) => (
                  <button key={message.id} type="button" onClick={() => locateMessage(message.id)}>
                    {message.kind === 'text'
                      ? message.text
                      : message.kind === 'tool'
                        ? message.title
                        : message.question}
                  </button>
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
          <AgentCreations doc={doc} onSelect={onViewCanvas} />
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
                  : 'flex shrink-0 flex-col gap-2.5'
              }
            >
              {messages.length === 0 && !historyLoading && !historyFailed && (
                <div className="studio-chat-empty">
                  <span className="studio-spark">✧</span>
                  <h3>{t('panel.emptyTitle')}</h3>
                  <p>{t('panel.emptyBody')}</p>
                  <AgentSuggestions className="studio-suggestions mt-6" />
                </div>
              )}
              {messages.map((message, index) => {
                const fetchedRun = fetchedRuns?.starts.get(index)
                if (fetchedRuns?.absorbed.has(index) && !fetchedRun) return null
                if (fetchedRun) {
                  const lastIndex = index + fetchedRun.length - 1
                  const footer =
                    lastOfTurn.get(message.turnId) === lastIndex ? turns[message.turnId] : null
                  return (
                    <div key={message.id} className="studio-agent-message-block">
                      <div className="studio-agent-fetched-strip">
                        {fetchedRun.map((image) => (
                          <div
                            key={image.id}
                            data-agent-message-id={image.id}
                            className="studio-agent-fetched-strip-item"
                          >
                            <AgentToolCard
                              message={image}
                              onViewCanvas={onViewCanvas}
                              onPreviewResult={onPreviewResult}
                              compactFetched
                            />
                          </div>
                        ))}
                      </div>
                      {footer && (
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
                    key={message.id}
                    data-agent-message-id={message.id}
                    className="studio-agent-message-block"
                  >
                    {trail && (
                      <AgentActivityTrail
                        steps={trail.steps}
                        spent={trail.spent}
                        revealId={locatedId}
                      />
                    )}
                    {!grouping.absorbed.has(index) &&
                      renderMessage(message, answerableId, skills, onViewCanvas, onPreviewResult)}
                    {footer && (
                      <AgentTurnCost footer={footer} jobs={jobsByTurn.get(message.turnId)} />
                    )}
                  </div>
                )
              })}
              <AgentActivity />
              <AgentHistoryStatus />
              {(error || returnedMessagesPending) && !historyFailed && (
                <ErrorState
                  title={t('panel.errorTitle')}
                  detail={
                    returnedMessagesPending
                      ? t('errors:agentQueue.return_handoff_failed')
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
            <button type="button" onClick={jumpToLatest} className={JUMP_TO_LATEST}>
              <ArrowDown className="h-3 w-3" aria-hidden="true" />
              {t('panel.jumpToLatest')}
            </button>
          )}
        </div>
      )}

      {tab === 'chat' && <AgentPendingDrafts />}
      {tab === 'chat' && <AgentMessageQueue />}
      {tab === 'chat' && (
        <AgentComposer
          doc={doc}
          editor={editor}
          showLooks={presentation !== 'page' || messages.length === 0}
          showCanvasReferences={presentation !== 'page'}
        />
      )}
    </div>
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
