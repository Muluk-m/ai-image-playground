import { ChevronRightIcon } from 'lucide-react'
import { useId, useLayoutEffect, useState } from 'react'
import { stepRow } from '../../../components/assistant-ui/elements/surfaces'
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
 * 一串只读过程步。跑着的时候只露当前这一步，做完的不往下堆；做完后不管几步都只留一行
 * 「已完成」，点开才逐条展开。失败的步骤始终露着：原因和处理入口不能藏。
 */
export default function AgentActivityTrail({
  steps,
  revealId,
  revealSeq,
}: {
  steps: readonly AgentToolMessage[]
  spent: boolean
  revealId?: string | null
  /** 第几次定位；同一步重复定位时靠它重新展开。 */
  revealSeq?: number
}) {
  const { t } = useTranslation('agent')
  const [open, setOpen] = useState(false)
  const id = useId()
  const revealed = revealId != null && steps.some((step) => step.id === revealId)
  // 搜索定位到这串里的某一步时先展开，滚动才找得到它；展开记进本地状态，用户之后还能收起。
  // 用 layout effect：定位方在下一帧找元素，展开得赶在那之前提交。
  useLayoutEffect(() => {
    if (revealed) setOpen(true)
  }, [revealed, revealId, revealSeq])
  const failed = steps.filter((step) => step.status === 'failed')
  const running = steps.filter(inFlight)

  let visible: readonly AgentToolMessage[]
  if (running.length) visible = revealed ? steps : [...failed, running[running.length - 1]!]
  else if (failed.length) visible = steps
  else visible = []

  if (visible.length) {
    return (
      <div className="flex shrink-0 flex-col gap-0.5">
        <Steps steps={visible} />
      </div>
    )
  }

  const expanded = open
  return (
    <div className="flex shrink-0 flex-col gap-0.5">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className={cn(stepRow, 'w-fit text-muted-foreground/80')}
      >
        {t('activity.done')}
        <ChevronRightIcon
          aria-hidden
          className={cn(
            'size-3.5 shrink-0 opacity-60 transition-transform motion-reduce:transition-none',
            expanded && 'rotate-90',
          )}
        />
      </button>
      <div id={id} hidden={!expanded} className="ml-[6px] border-l border-border pl-[10px]">
        {expanded && <Steps steps={steps} />}
      </div>
    </div>
  )
}
