// Adapted from assistant-ui Elements tool-call (MIT), retrieved 2026-09-24.
// https://r.assistant-ui.com/elements-tool-call.json
import { Check, CircleAlert, Clock3, LoaderCircle } from 'lucide-react'

export function ToolStatus({
  label,
  status,
}: {
  label: string
  status: 'running' | 'queued' | 'succeeded' | 'failed' | 'waiting'
}) {
  const active = status === 'running'
  const Icon =
    status === 'succeeded'
      ? Check
      : status === 'failed'
        ? CircleAlert
        : status === 'queued' || status === 'waiting'
          ? Clock3
          : LoaderCircle
  return (
    <span
      data-slot="tool-status"
      data-status={status}
      className={`inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium ${
        status === 'failed'
          ? 'bg-destructive/10 text-destructive'
          : status === 'succeeded'
            ? 'bg-primary/10 text-primary'
            : 'bg-background/70 text-muted-foreground'
      }`}
    >
      <Icon
        aria-hidden="true"
        className={`h-3 w-3 ${active ? 'animate-spin motion-reduce:animate-none' : ''}`}
      />
      <span className={active ? 'agent-shimmer relative' : ''}>{label}</span>
    </span>
  )
}
