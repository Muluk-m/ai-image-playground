import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

interface ModelChipsProps {
  models: string[]
  max?: number
}

export function ModelChips({ models, max = 3 }: ModelChipsProps) {
  if (!models.length) return <span className="text-xs text-muted-foreground">—</span>
  const visible = models.slice(0, max)
  const rest = models.slice(max)
  return (
    <div className="flex flex-wrap items-center gap-1">
      {visible.map((m) => (
        <Badge key={m} variant="secondary" className="font-mono text-[10px]">
          {m}
        </Badge>
      ))}
      {rest.length > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="cursor-help text-[10px]">
              +{rest.length} more
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            <div className="space-y-0.5 font-mono text-xs">
              {rest.map((m) => (
                <div key={m}>{m}</div>
              ))}
            </div>
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  )
}
