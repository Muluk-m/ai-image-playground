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
  const [copied, setCopied] = useState(false)
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
    if (!ok) return
    setCopied(true)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setCopied(false), 1200)
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'inline-flex items-center gap-1 font-mono text-xs text-foreground',
            className,
          )}
        >
          {compact ? null : <span>{shortId(value, len)}</span>}
          {copy ? (
            <Button
              autoTooltip={false}
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onCopy}
              aria-label={copied ? '已复制 ID' : '复制 ID'}
              className="text-muted-foreground hover:text-foreground"
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            </Button>
          ) : null}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <span className="font-mono text-xs">
          {copy ? `${copied ? '已复制' : '复制'}：${value}` : `完整 ID：${value}`}
        </span>
      </TooltipContent>
    </Tooltip>
  )
}
