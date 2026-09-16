import {
  Fragment,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react'
import Credits from '../../../components/Credits'
import { PlusIcon } from '../../../components/icons'
import { useImageDropZone } from '../../../hooks/useImageDropZone'
import type { CanvasDoc } from '../../canvas/lib/canvasDoc'
import type { CanvasEditor } from '../../canvas/lib/editor'
import { useCanvasProjectStore } from '../../canvas/projectStore'
import { useLibraryStore } from '../../library/store'
import {
  ACTIVE_TAB,
  GHOST_LINK,
  ICON_BUTTON,
  IDLE_TAB,
  INK_3,
  TAB,
  USER_BUBBLE,
} from '../agentStyles'
import { attachFilesToComposer } from '../lib/attachments'
import { agentSessionCredits } from '../lib/turnCost'
import { agentPanelPresent } from '../panelLayout'
import { answerableClarificationId, useAgentStore } from '../store'
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
  { id: 'chat', label: '对话' },
  { id: 'layers', label: '创作记录' },
] as const

function CollapsedButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="studio-open-chat">
      展开对话
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

export default function AgentPanel({ doc, editor }: { doc: CanvasDoc; editor: CanvasEditor }) {
  const open = useAgentStore((state) => state.open)
  const tab = useAgentStore((state) => state.tab)
  const messages = useAgentStore((state) => state.messages)
  const turns = useAgentStore((state) => state.turns)
  const error = useAgentStore((state) => state.error)
  const panelWidth = useAgentStore((state) => state.panelWidth)
  const { setOpen, setTab, load, createProject, setPanelWidth } = useAgentStore.getState()
  const historyLoading = useAgentStore((state) => state.historyLoading)
  const historyFailed = useAgentStore((state) => state.historyFailed)
  const projectName = useCanvasProjectStore(
    (state) => state.projects.find((one) => one.id === state.activeId)?.name ?? '未命名项目',
  )
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
  if (!open) return <CollapsedButton onOpen={() => setOpen(true)} />

  const answerableId = answerableClarificationId(messages)

  return (
    <div aria-label="创作对话" style={{ width: panelWidth }} className="studio-sidebar">
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调整面板宽度"
        title="拖动调整宽度"
        onPointerDown={startResize}
        className="absolute -right-1.5 top-6 bottom-6 z-10 hidden md:block w-3 cursor-col-resize touch-none rounded-full transition-colors hover:bg-primary/40 active:bg-primary/60"
      />
      <div className="flex shrink-0 items-center justify-between gap-3 px-4 pb-3 pt-2">
        <div className="flex items-center gap-3">
          {TABS.map((one) => (
            <button
              key={one.id}
              type="button"
              onClick={() => setTab(one.id)}
              className={`${TAB} ${(one.id === 'chat' ? tab !== 'layers' : tab === one.id) ? ACTIVE_TAB : IDLE_TAB}`}
            >
              {one.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-label="收起面板"
          className={ICON_BUTTON}
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

      <div className="flex shrink-0 items-center gap-2 px-4 pb-3">
        <div className="min-w-0 flex-1">
          <button
            type="button"
            className={`${GHOST_LINK} block max-w-full truncate text-left`}
            title={projectName}
            onClick={() => useLibraryStore.getState().openPanel('projects')}
          >
            {projectName}
          </button>
          {sessionCredits !== null && (
            <span
              className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground"
              aria-label={`已用 ${sessionCredits.toLocaleString()} 积分`}
            >
              已用 <Credits credits={sessionCredits} /> 积分
            </span>
          )}
        </div>
        <button
          type="button"
          aria-label="新建项目"
          className={ICON_BUTTON}
          onClick={() => void createProject()}
        >
          <PlusIcon className="h-3.5 w-3.5" />
        </button>
      </div>
      {tab === 'layers' ? (
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          <AgentCreations doc={doc} editor={editor} />
        </div>
      ) : (
        <div
          ref={logRef}
          aria-label="对话记录"
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
              <h3>今天，想创作什么？</h3>
              <p>
                描述你的想法，或添加一张参考图。生成的作品会出现在右侧画布，选中后可以继续修改。
              </p>
              <div className="studio-example">试着描述画面中的主体、风格和氛围。</div>
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
