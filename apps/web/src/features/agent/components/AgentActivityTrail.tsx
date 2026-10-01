import type { AgentToolMessage } from '../types'
import AgentToolCard from './AgentToolCard'

/** Read-only calls use the same inspectable assistant-ui tool surface as every other call. */
export default function AgentActivityTrail({
  steps,
}: {
  steps: readonly AgentToolMessage[]
  spent: boolean
  revealId?: string | null
}) {
  return (
    <div className="flex shrink-0 flex-col gap-2">
      {steps.map((step) => (
        <div key={step.id} data-agent-message-id={step.id}>
          <AgentToolCard message={step} />
        </div>
      ))}
    </div>
  )
}
