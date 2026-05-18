import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { fuzzyTime, isoTime } from '@/lib/format'

interface FuzzyTimeProps {
  ts: number | null
  className?: string
}

export function FuzzyTime({ ts, className }: FuzzyTimeProps) {
  if (!ts) return <span className="text-xs text-muted-foreground">—</span>
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={className ?? 'text-xs text-muted-foreground'}>{fuzzyTime(ts)}</span>
      </TooltipTrigger>
      <TooltipContent>
        <span className="font-mono text-xs">{isoTime(ts)}</span>
      </TooltipContent>
    </Tooltip>
  )
}
