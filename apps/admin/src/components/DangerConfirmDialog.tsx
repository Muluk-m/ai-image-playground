import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'

const REASON_MAX = 200

export function DangerConfirmDialog({
  open,
  onOpenChange,
  title,
  impact,
  versionNote,
  confirmLabel,
  destructive = true,
  pending = false,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  impact: string
  versionNote?: string
  confirmLabel: string
  destructive?: boolean
  pending?: boolean
  onConfirm: (reason: string) => void
}) {
  const [reason, setReason] = useState('')
  useEffect(() => {
    if (open) setReason('')
  }, [open])
  const trimmed = reason.trim()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="rounded-lg border bg-muted/40 px-3 py-2 text-sm leading-6">{impact}</p>
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium">
              原因 <span className="text-danger">*</span>
            </span>
            <Textarea
              value={reason}
              onChange={(event) => setReason(event.target.value.slice(0, REASON_MAX))}
              maxLength={REASON_MAX}
              rows={3}
              required
              aria-label="原因"
              placeholder="写给审计日志"
            />
            <span className="block text-right text-xs text-muted-foreground">
              {reason.length}/{REASON_MAX}
            </span>
          </label>
          {versionNote ? <p className="text-xs text-muted-foreground">{versionNote}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            取消
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            disabled={pending || trimmed.length === 0}
            onClick={() => onConfirm(trimmed)}
          >
            {pending ? '提交中…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
