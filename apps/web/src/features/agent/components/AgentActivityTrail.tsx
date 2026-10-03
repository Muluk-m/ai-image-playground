import { ChevronRightIcon, Loader } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from '../../../i18n'
import { cn } from '../../../lib/utils'
import type { AgentToolMessage } from '../types'
import AgentToolCard from './AgentToolCard'

const inFlight = (step: AgentToolMessage) =>
  step.status === 'running' || step.status === 'submitted' || step.status === 'queued'

function Steps({ steps }: { steps: readonly AgentToolMessage[] }) {
  return steps.map((step) => (
    <div key={step.id} data-agent-message-id={step.id}>
      <AgentToolCard message={step} />
    </div>
  ))
}

/**
 * 一串只读过程步。跑着的时候只露当前这一步，做完的不往下堆；全部做完后收成一行
 * 「已完成 N 步」，点开才逐条展开。失败的步骤始终露着：原因和处理入口不能藏。
 */
export default function AgentActivityTrail({
  steps,
  revealId,
}: {
  steps: readonly AgentToolMessage[]
  spent: boolean
  revealId?: string | null
}) {
  const { t } = useTranslation('agent')
  const [open, setOpen] = useState(false)
  const id = useId()
  const failed = steps.filter((step) => step.status === 'failed')
  const running = steps.filter(inFlight)

  let visible: readonly AgentToolMessage[]
  if (running.length) visible = [...failed, running[running.length - 1]!]
  else if (steps.length === 1 || failed.length) visible = steps
  else visible = []

  if (visible.length) {
    return (
      <div className="flex shrink-0 flex-col gap-0.5">
        <Steps steps={visible} />
      </div>
    )
  }

  // 搜索定位到折起来的某一步时，先把这串展开，滚动才找得到它。
  const expanded = open || (revealId != null && steps.some((step) => step.id === revealId))
  return (
    <div className="flex shrink-0 flex-col gap-0.5">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={id}
        onClick={() => setOpen(!expanded)}
        className="group flex w-fit items-center gap-2 rounded-lg px-2 py-1.5 text-body-sm text-muted-foreground/80 transition-colors hover:bg-accent hover:text-muted-foreground"
      >
        <Loader aria-hidden className="size-3.5 shrink-0 text-primary/70" />
        {t('activity.stepsDone', { count: steps.length })}
        <ChevronRightIcon
          aria-hidden
          className={cn(
            'size-3.5 shrink-0 transition-transform motion-reduce:transition-none',
            expanded && 'rotate-90',
          )}
        />
      </button>
      <div id={id} hidden={!expanded} className="ml-3.5 border-l border-border pl-2">
        {expanded && <Steps steps={steps} />}
      </div>
    </div>
  )
}
