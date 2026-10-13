// Adapted from assistant-ui Elements tool-call (MIT), retrieved 2026-09-24.
// https://r.assistant-ui.com/elements-tool-call.json
import { Icon } from '../../ui/icon'

export function ToolStatus({
  label,
  status,
}: {
  label: string
  status: 'running' | 'queued' | 'succeeded' | 'failed' | 'waiting'
}) {
  const active = status === 'running'
  const icon =
    status === 'succeeded'
      ? 'check'
      : status === 'failed'
        ? 'error'
        : status === 'queued' || status === 'waiting'
          ? 'clock'
          : 'loading'
  return (
    <span
      data-slot="tool-status"
      data-status={status}
      className="inline-flex shrink-0 items-center gap-1 rounded-md bg-foreground/5 px-1.5 py-0.5 text-label-sm font-medium text-muted-foreground"
    >
      <Icon
        name={icon}
        size="xs"
        className={`${active ? 'animate-spin motion-reduce:animate-none' : ''}`}
      />
      <span className={active ? 'agent-shimmer relative' : ''}>{label}</span>
    </span>
  )
}
