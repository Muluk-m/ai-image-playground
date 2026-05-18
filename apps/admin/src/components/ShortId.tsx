import { Check, Copy } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { copyText, shortId } from '@/lib/format'
import { cn } from '@/lib/utils'

interface ShortIdProps {
  value: string
  len?: number
  className?: string
}

export function ShortId({ value, len = 8, className }: ShortIdProps) {
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
          <span>{shortId(value, len)}</span>
          <button
            type="button"
            onClick={onCopy}
            aria-label="复制"
            className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          </button>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <span className="font-mono text-xs">{value}</span>
      </TooltipContent>
    </Tooltip>
  )
}
