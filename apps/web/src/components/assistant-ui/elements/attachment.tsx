// Presentation adapter for assistant-ui AttachmentUI (MIT), assistant-ui@9121416.
import { ImageIcon } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '../../../lib/utils'

export function AttachmentTile({
  name,
  failed,
  children,
  className,
  ...props
}: ComponentProps<'div'> & { name: string; failed?: boolean }) {
  return (
    <div
      data-slot="attachment"
      aria-label={name}
      className={cn(
        'group relative size-16 shrink-0 overflow-hidden rounded-xl border bg-muted',
        failed ? 'border-destructive' : 'border-border/70',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  )
}

export function AttachmentLoading({ label }: { label?: ReactNode }) {
  return (
    <span
      data-slot="attachment-loading"
      aria-hidden
      className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 overflow-hidden rounded-[inherit] bg-muted text-muted-foreground"
    >
      <span className="absolute inset-0 animate-pulse bg-foreground/[0.04] motion-reduce:animate-none" />
      <ImageIcon className="size-4 opacity-40" />
      {label && <span className="text-[10px] leading-3">{label}</span>}
    </span>
  )
}
