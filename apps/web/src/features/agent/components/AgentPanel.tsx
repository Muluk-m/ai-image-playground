import type { AgentSkillSummary } from '@image-playground/shared'
import { ArrowDown } from 'lucide-react'
import {
  Fragment,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useImageDropZone } from '../../../hooks/useImageDropZone'
import { useTranslation } from '../../../i18n'
import type { CanvasDoc } from '../../canvas/lib/canvasDoc'
import type { CanvasEditor } from '../../canvas/lib/editor'
import { ACTIVE_TAB, ICON_BUTTON, IDLE_TAB, INK_3, JUMP_TO_LATEST, TAB } from '../agentStyles'
import { attachFilesToComposer } from '../lib/attachments'
import { answerableClarificationId } from '../lib/panelMessages'
import { useAgentSkills } from '../lib/useAgentSkills'
import { agentPanelPresent } from '../panelLayout'
import { useAgentStore } from '../store'
import type { AgentPanelMessage } from '../types'
import AgentActivity from './AgentActivity'
import AgentClarification from './AgentClarification'
import AgentComposer from './AgentComposer'
import AgentConnectionHint from './AgentConnectionHint'
import AgentCreations from './AgentCreations'
import AgentHistoryStatus from './AgentHistoryStatus'
import AgentMessageQueue from './AgentMessageQueue'
import AgentPendingDrafts from './AgentPendingDrafts'
import AgentReply from './AgentReply'
import AgentSkillStep from './AgentSkillStep'
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
) {
  if (message.kind === 'tool') {
    // 读取技能只是一步，不是一件产出；它走不到结果卡那条路。
    return message.toolName === 'loadSkill' ? (
      <AgentSkillStep message={message} />
    ) : (
      <AgentToolCard message={message} />
    )
  }
  if (message.kind === 'clarification') {
    return <AgentClarification message={message} answered={message.id !== answerableId} />
  }
  if (message.role === 'user') return <AgentUserMessage message={message} skills={skills} />
  return <AgentReply text={message.text} streaming={message.streaming} />
}

export default function AgentPanel({
  doc,
  editor,
  mobile = false,
  onViewCanvas,
}: {
  doc: CanvasDoc
  editor: CanvasEditor
  mobile?: boolean
  onViewCanvas?: () => void
}) {
  const { t } = useTranslation('agent')
  const open = useAgentStore((state) => state.open)
  const tab = useAgentStore((state) => state.tab)
  const messages = useAgentStore((state) => state.messages)
  const turns = useAgentStore((state) => state.turns)
  const imageSkills = useAgentSkills('image')
  const videoSkills = useAgentSkills('video')
  const skills = useMemo(() => [...imageSkills, ...videoSkills], [imageSkills, videoSkills])
  const error = useAgentStore((state) => state.error)
  const panelWidth = useAgentStore((state) => state.panelWidth)
  const { setOpen, setTab, load, setPanelWidth } = useAgentStore.getState()
  const historyLoading = useAgentStore((state) => state.historyLoading)
  const historyFailed = useAgentStore((state) => state.historyFailed)
  const logRef = useRef<HTMLDivElement>(null)
  const followLatest = useRef(true)
  /** 离开底部期间来了新内容：浮出「有新消息」，回到底部即收起。 */
  const [unseen, setUnseen] = useState(false)
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
  if (!open && !mobile) return <CollapsedButton onOpen={() => setOpen(true)} />

  const answerableId = answerableClarificationId(messages)
  // 页脚跟在本轮最后一条消息后面。重试记录自成一轮、按时间追加在对话末尾，可能夹在一轮的
  // 消息中间，所以按「这一轮的最后一条」认，而不只看下一条换没换轮。
  const lastOfTurn = new Map(messages.map((message, index) => [message.turnId, index]))

  return (
    <div aria-label={t('panel.aria')} style={{ width: panelWidth }} className="studio-sidebar">
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('panel.resizeAria')}
        title={t('panel.resizeTitle')}
        onPointerDown={startResize}
        className="absolute -right-1.5 top-6 bottom-6 z-10 hidden md:block w-3 cursor-col-resize touch-none rounded-full transition-colors hover:bg-primary/40 active:bg-primary/60"
      />
      <div className="studio-agent-tabs flex shrink-0 items-center justify-between gap-3 px-4 pb-3 pt-2">
        <div className="flex items-center gap-3">
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

      <AgentConnectionHint />

      {tab === 'layers' ? (
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          <AgentCreations doc={doc} onSelect={mobile ? onViewCanvas : undefined} />
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
            className={`relative flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto overscroll-contain px-3 py-1 ${dragging ? 'rounded-xl outline-dashed outline-1 outline-ring/70' : ''}`}
            {...dropZoneProps}
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
              const footer = lastOfTurn.get(message.turnId) === index ? turns[message.turnId] : null
              return (
                <Fragment key={message.id}>
                  {renderMessage(message, answerableId, skills)}
                  {footer && <AgentTurnCost footer={footer} />}
                </Fragment>
              )
            })}
            <AgentActivity />
            <AgentHistoryStatus />
            {error && !historyFailed && <p className={`text-xs ${INK_3}`}>{error}</p>}
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
      {tab === 'chat' && <AgentComposer doc={doc} editor={editor} />}
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
