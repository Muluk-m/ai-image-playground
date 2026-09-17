import {
  Fragment,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react'
import ProjectNavigation from '../../../components/ProjectNavigation'
import { useImageDropZone } from '../../../hooks/useImageDropZone'
import { useTranslation } from '../../../i18n'
import type { CanvasDoc } from '../../canvas/lib/canvasDoc'
import type { CanvasEditor } from '../../canvas/lib/editor'
import { ACTIVE_TAB, ICON_BUTTON, IDLE_TAB, INK_3, TAB, USER_BUBBLE } from '../agentStyles'
import { attachFilesToComposer } from '../lib/attachments'
import { answerableClarificationId } from '../lib/panelMessages'
import { agentSessionCredits } from '../lib/turnCost'
import { agentPanelPresent } from '../panelLayout'
import { useAgentStore } from '../store'
import type { AgentPanelMessage } from '../types'
import AgentActivity from './AgentActivity'
import AgentClarification from './AgentClarification'
import AgentComposer from './AgentComposer'
import AgentCreations from './AgentCreations'
import AgentHistoryStatus from './AgentHistoryStatus'
import AgentReply from './AgentReply'
import AgentToolCard from './AgentToolCard'
import AgentTurnCost from './AgentTurnCost'

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

function renderMessage(message: AgentPanelMessage, answerableId: string | null) {
  if (message.kind === 'tool') return <AgentToolCard message={message} />
  if (message.kind === 'clarification') {
    return <AgentClarification message={message} answered={message.id !== answerableId} />
  }
  if (message.role === 'user') return <p className={USER_BUBBLE}>{message.text}</p>
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
  const error = useAgentStore((state) => state.error)
  const panelWidth = useAgentStore((state) => state.panelWidth)
  const { setOpen, setTab, load, setPanelWidth } = useAgentStore.getState()
  const historyLoading = useAgentStore((state) => state.historyLoading)
  const historyFailed = useAgentStore((state) => state.historyFailed)
  const logRef = useRef<HTMLDivElement>(null)
  const followLatest = useRef(true)
  const conversationId = useAgentStore((state) => state.conversationId)
  useLayoutEffect(() => {
    followLatest.current = true
  }, [conversationId, open, tab])
  // 文件拖到对话记录上也算数：草稿归输入框管，这里只把文件递过去。
  const { dragging, dropZoneProps } = useImageDropZone((files) => {
    attachFilesToComposer(files)
  })
  // 流式输出时这个组件每个字都重渲染一次，别让它顺带把整张轮表遍历两遍。
  const sessionCredits = useMemo(
    () => (Object.values(turns).some((footer) => footer.cost) ? agentSessionCredits(turns) : null),
    [turns],
  )

  useEffect(() => {
    void load()
  }, [load])

  useLayoutEffect(() => {
    const log = logRef.current
    if (log && followLatest.current) log.scrollTop = log.scrollHeight
  }, [messages, open, tab, conversationId])

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
      <ProjectNavigation credits={sessionCredits} />
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

      {tab === 'layers' ? (
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          <AgentCreations doc={doc} editor={editor} onSelect={mobile ? onViewCanvas : undefined} />
        </div>
      ) : (
        <div
          ref={logRef}
          // 全站默认禁止选中文字（画布拖拽不能拖出一片高亮）；对话记录是要被复制的，放开。
          data-selectable-text
          aria-label={t('panel.logAria')}
          onScroll={(event) => {
            const log = event.currentTarget
            followLatest.current = log.scrollHeight - log.clientHeight - log.scrollTop <= 48
          }}
          className={`relative flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3 py-1 ${dragging ? 'rounded-xl outline-dashed outline-1 outline-ring/70' : ''}`}
          {...dropZoneProps}
        >
          {messages.length === 0 && !historyLoading && !historyFailed && (
            <div className="studio-chat-empty">
              <span className="studio-spark">✧</span>
              <h3>{t('panel.emptyTitle')}</h3>
              <p>{t('panel.emptyBody')}</p>
              <div className="studio-example">{t('panel.emptyExample')}</div>
            </div>
          )}
          {messages.map((message, index) => {
            // 页脚跟在本轮最后一条消息后面，所以只在下一条换了轮时渲染。
            const footer =
              messages[index + 1]?.turnId === message.turnId ? null : turns[message.turnId]
            return (
              <Fragment key={message.id}>
                {renderMessage(message, answerableId)}
                {footer && <AgentTurnCost footer={footer} />}
              </Fragment>
            )
          })}
          <AgentActivity />
          <AgentHistoryStatus />
          {error && !historyFailed && <p className={`text-xs ${INK_3}`}>{error}</p>}
        </div>
      )}

      {tab === 'chat' && <AgentComposer doc={doc} editor={editor} />}
    </div>
  )
}
