import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import type { CanvasDoc } from '../../canvas/lib/canvasDoc'
import {
  ABORT_BUTTON,
  ACTIVE_TAB,
  FIELD,
  ICON_BUTTON,
  IDLE_TAB,
  INK_3,
  PANEL_MARGIN,
  PANEL_SHADOW,
  PANEL_SURFACE,
  PANEL_WIDTH,
  SEND_BUTTON,
  TAB,
  USER_BUBBLE,
} from '../agentStyles'
import { agentPanelPresent } from '../panelLayout'
import { useAgentStore } from '../store'
import AgentLayers from './AgentLayers'
import AgentReply from './AgentReply'

const TABS = [
  { id: 'chat', label: '对话' },
  { id: 'layers', label: '图层' },
] as const

function CollapsedButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      style={{ left: PANEL_MARGIN, top: PANEL_MARGIN }}
      className={`absolute z-[400] rounded-xl px-3 py-1.5 text-xs ${PANEL_SURFACE} ${PANEL_SHADOW} text-[#e8e8ea]`}
    >
      对话
    </button>
  )
}

export default function AgentPanel({ doc }: { doc: CanvasDoc }) {
  const open = useAgentStore((state) => state.open)
  const tab = useAgentStore((state) => state.tab)
  const messages = useAgentStore((state) => state.messages)
  const turn = useAgentStore((state) => state.turn)
  const error = useAgentStore((state) => state.error)
  const { setOpen, setTab, load, send, abort } = useAgentStore.getState()
  const [draft, setDraft] = useState('')
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const log = logRef.current
    if (log) log.scrollTop = log.scrollHeight
  }, [messages])

  if (!agentPanelPresent()) return null
  if (!open) return <CollapsedButton onOpen={() => setOpen(true)} />

  const submit = () => {
    const text = draft
    setDraft('')
    void send(text)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    submit()
  }

  return (
    <div
      style={{
        left: PANEL_MARGIN,
        top: PANEL_MARGIN,
        bottom: PANEL_MARGIN,
        width: PANEL_WIDTH,
      }}
      className={`absolute z-[400] flex flex-col rounded-2xl ${PANEL_SURFACE} ${PANEL_SHADOW}`}
    >
      <div className="flex shrink-0 items-center justify-between gap-3 px-3 pb-1.5 pt-2">
        <div className="flex items-center gap-3">
          {TABS.map((one) => (
            <button
              key={one.id}
              type="button"
              onClick={() => setTab(one.id)}
              className={`${TAB} ${tab === one.id ? ACTIVE_TAB : IDLE_TAB}`}
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

      {tab === 'layers' ? (
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          <AgentLayers doc={doc} />
        </div>
      ) : (
        <div
          ref={logRef}
          className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3 py-1"
        >
          {messages.length === 0 && <p className={`text-xs ${INK_3}`}>还没有对话</p>}
          {messages.map((message) =>
            message.role === 'user' ? (
              <p key={message.id} className={USER_BUBBLE}>
                {message.text}
              </p>
            ) : (
              <AgentReply
                key={message.id}
                messageId={message.id}
                text={message.text}
                streaming={message.streaming}
              />
            ),
          )}
          {error && <p className={`text-xs ${INK_3}`}>{error}</p>}
        </div>
      )}

      {tab === 'chat' && (
        <div className="flex shrink-0 flex-col gap-2 px-3 pb-3 pt-2">
          <textarea
            rows={2}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="说一句你想做什么"
            className={FIELD}
          />
          <div className="flex items-center justify-end gap-2">
            {turn === 'running' && (
              <button type="button" className={ABORT_BUTTON} onClick={() => void abort()}>
                中止
              </button>
            )}
            <button type="button" className={SEND_BUTTON} disabled={!draft.trim()} onClick={submit}>
              {turn === 'running' ? '插话' : '发送'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
