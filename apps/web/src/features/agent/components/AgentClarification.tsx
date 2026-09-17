import { type FormEvent, useState } from 'react'
import { CARD, CARD_NOTE, CARD_TITLE, CHOICE, CHOICE_FIELD, CHOICE_SUBMIT } from '../agentStyles'
import { useAgentStore } from '../store'
import type { AgentClarificationMessage } from '../types'

export default function AgentClarification({
  message,
  answered,
}: {
  message: AgentClarificationMessage
  answered: boolean
}) {
  const running = useAgentStore((state) => state.turn === 'running')
  const [writing, setWriting] = useState(false)
  const [other, setOther] = useState('')
  const locked = answered || running
  const answer = other.trim()

  const submitOther = (event: FormEvent) => {
    event.preventDefault()
    if (locked || !answer) return
    void useAgentStore.getState().send(answer)
  }

  return (
    <div className={CARD}>
      <p className={CARD_TITLE}>{message.question}</p>
      <div className="flex flex-col gap-1">
        {message.options.map((option) => (
          <button
            key={option}
            type="button"
            disabled={locked}
            className={CHOICE}
            onClick={() => void useAgentStore.getState().send(option)}
          >
            {option}
          </button>
        ))}
        {/* 模型给的方案都不对时的出口：在卡片里直接写，不用挪到底下的输入框。 */}
        {writing && !answered ? (
          <form className="flex items-center gap-1" onSubmit={submitOther}>
            <input
              // 用户刚点了「其他」，下一步就是打字。
              autoFocus
              aria-label="其他回答"
              value={other}
              disabled={running}
              placeholder="说说你想要的"
              className={CHOICE_FIELD}
              onChange={(event) => setOther(event.target.value)}
              // 输入法选词的回车不是提交。
              onKeyDown={(event) => {
                if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault()
              }}
            />
            <button type="submit" disabled={locked || !answer} className={CHOICE_SUBMIT}>
              发送
            </button>
          </form>
        ) : (
          <button
            type="button"
            disabled={locked}
            className={`${CHOICE} text-muted-foreground`}
            onClick={() => setWriting(true)}
          >
            其他…
          </button>
        )}
      </div>
      {answered && <p className={CARD_NOTE}>已回答</p>}
    </div>
  )
}
