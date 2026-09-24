import { ADMIN_USER_NOTE_MAX_LENGTH } from '@image-playground/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { ApiError, apiClient } from '@/lib/api-client'
import type { AdminUserRow } from '@/lib/types'

export function UserNoteDialog({
  user,
  open,
  onOpenChange,
}: {
  user: AdminUserRow | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setDraft(user?.note ?? '')
    setError(null)
  }, [open, user?.id, user?.note])

  const mutation = useMutation({
    mutationFn: async () => {
      if (!user) throw new Error('missing user')
      return apiClient.patch(`/api/users/${encodeURIComponent(user.id)}/note`, {
        note: draft.trim(),
      })
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['users'] }),
        queryClient.invalidateQueries({ queryKey: ['user', user?.id] }),
      ])
      onOpenChange(false)
    },
    onError: (cause) => {
      const code = cause instanceof ApiError && (cause.body as { error?: string })?.error
      setError(code === 'user_not_found' ? '用户不存在或已被删除' : '保存失败，请重试')
    },
  })

  return (
    <Dialog open={open} onOpenChange={(next) => !mutation.isPending && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑用户备注</DialogTitle>
          <DialogDescription>
            {user?.username} · 仅运维后台可见，清空后保存可删除备注。
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            setError(null)
            mutation.mutate()
          }}
        >
          <div className="space-y-1.5">
            <label htmlFor="admin-user-note" className="text-sm font-medium">
              备注
            </label>
            <Textarea
              id="admin-user-note"
              value={draft}
              onChange={(event) => setDraft(event.currentTarget.value)}
              maxLength={ADMIN_USER_NOTE_MAX_LENGTH}
              rows={4}
              placeholder="例如：合作方、测试账号或跟进事项"
              disabled={mutation.isPending}
              autoFocus
            />
            <p className="text-right text-xs text-muted-foreground">
              {draft.length} / {ADMIN_USER_NOTE_MAX_LENGTH}
            </p>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={mutation.isPending}
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button
              type="submit"
              disabled={mutation.isPending || draft.trim() === (user?.note ?? '')}
            >
              {mutation.isPending ? '保存中…' : '保存备注'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
