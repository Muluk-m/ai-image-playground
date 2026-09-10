import { CARD, CARD_NOTE, CARD_TITLE, CHOICE } from '../agentStyles'
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
  return (
    <div className={CARD}>
      <p className={CARD_TITLE}>{message.question}</p>
      <div className="flex flex-col gap-1">
        {message.options.map((option) => (
          <button
            key={option}
            type="button"
            disabled={answered || running}
            className={CHOICE}
            onClick={() => void useAgentStore.getState().send(option)}
          >
            {option}
          </button>
        ))}
      </div>
      {answered && <p className={CARD_NOTE}>已回答</p>}
    </div>
  )
}
