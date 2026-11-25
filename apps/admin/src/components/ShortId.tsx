import { Check, Copy } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { copyText, shortId } from '@/lib/format'
import { cn } from '@/lib/utils'

interface ShortIdProps {
  value: string
  len?: number
  className?: string
  compact?: boolean
  copy?: boolean
}

export function ShortId({ value, len = 8, className, compact = false, copy = true }: ShortIdProps) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    [],
  )

  async function onCopy(e: React.MouseEvent): Promise<void> {
    e.stopPropagation()
    const ok = await copyText(value)
    setCopyState(ok ? 'copied' : 'failed')
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setCopyState('idle'), 1500)
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'inline-flex items-center gap-1 whitespace-nowrap font-mono text-xs text-foreground',
            className,
          )}
        >
          {compact ? null : <span className="whitespace-nowrap">{shortId(value, len)}</span>}
          {copy ? (
            <Button
              autoTooltip={false}
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onCopy}
              aria-label={
                copyState === 'copied'
                  ? '已复制 ID'
                  : copyState === 'failed'
                    ? '复制 ID 失败'
                    : '复制 ID'
              }
              className="shrink-0 text-muted-foreground hover:text-foreground"
            >
              {copyState === 'copied' ? (
                <Check className="h-3 w-3" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
            </Button>
          ) : null}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <span className="font-mono text-xs">
          {copy
            ? `${copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败' : '复制'}：${value}`
            : `完整 ID：${value}`}
        </span>
      </TooltipContent>
    </Tooltip>
  )
}
