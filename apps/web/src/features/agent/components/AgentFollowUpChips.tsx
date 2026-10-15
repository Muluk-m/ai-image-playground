import { useSyncExternalStore } from 'react'
import { Button } from '../../../components/ui/button'
import { fillAgentComposer } from '../lib/composerFill'
import { visibleFollowUps } from '../lib/followUps'
import { currentProjectDraft } from '../lib/projectLifecycle'
import { useAgentStore } from '../store'

/**
 * 下一句建议跟在对话记录末尾，和正文一起滚。不钉在输入框上。
 * 点一下只把那句填进输入框，发不发仍由用户决定。
 */
export default function AgentFollowUpChips() {
  const conversationId = useAgentStore((state) => state.conversationId)
  const session = currentProjectDraft(conversationId)
  const draft = useSyncExternalStore(
    session.subscribe,
    () => session.getSnapshot().draft.prompt,
    () => '',
  )
  const idle = useAgentStore((state) => state.turn !== 'running' && !state.stopping)
  const historyBlocked = useAgentStore((state) => state.historyLoading || state.historyFailed)
  const messages = useAgentStore((state) => state.messages)
  const turns = useAgentStore((state) => state.turns)
  const lines = visibleFollowUps({
    idle,
    historyBlocked,
    welcome: false,
    draft,
    messages,
    turns,
  })
  if (!lines.length) return null
  return (
    <div className="studio-follow-ups flex flex-wrap gap-2 pt-1">
      {lines.map((line) => (
        <Button
          key={line}
          type="button"
          variant="outline"
          size="sm"
          className="h-8 rounded-full px-3 font-normal text-muted-foreground"
          onClick={() => fillAgentComposer({ text: line, replace: true })}
        >
          {line}
        </Button>
      ))}
    </div>
  )
}
