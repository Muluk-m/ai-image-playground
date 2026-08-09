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
import { Input } from '@/components/ui/input'
import { ApiError, apiClient } from '@/lib/api-client'
import type { AdminUserRow } from '@/lib/types'

const USERNAME_PATTERN = '[A-Za-z0-9._\\-]+'

interface UserFormDialogProps {
  mode: 'create' | 'reset'
  user?: AdminUserRow
  open: boolean
  onOpenChange: (open: boolean) => void
}

function messageForError(error: unknown): string {
  if (error instanceof ApiError && error.body && typeof error.body === 'object') {
    const code = (error.body as { error?: unknown }).error
    if (code === 'username_taken') return '该账号已存在'
    if (code === 'invalid_username') return '账号仅支持 3–32 位小写字母、数字、点、横线和下划线'
    if (code === 'invalid_password') return '密码长度需为 8–128 位'
    if (code === 'user_not_found') return '账号不存在或已被删除'
  }
  return '操作失败，请稍后重试'
}

export function UserFormDialog({ mode, user, open, onOpenChange }: UserFormDialogProps) {
  const queryClient = useQueryClient()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setUsername('')
    setPassword('')
    setError(null)
  }, [open])

  const mutation = useMutation({
    mutationFn: async () => {
      if (mode === 'create') {
        return apiClient.post('/api/users', { username, password })
      }
      if (!user) throw new Error('missing user')
      return apiClient.post(`/api/users/${encodeURIComponent(user.id)}/reset-password`, {
        password,
      })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['users'] })
      if (user) await queryClient.invalidateQueries({ queryKey: ['user', user.id] })
      onOpenChange(false)
    },
    onError: (mutationError) => setError(messageForError(mutationError)),
  })

  const title = mode === 'create' ? '创建账号' : `重置 ${user?.username ?? ''} 的密码`
  const description =
    mode === 'create'
      ? '账号创建后立即可用于经营站点登录。'
      : '保存后该账号的所有现有登录会话会立即失效。'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            setError(null)
            mutation.mutate()
          }}
        >
          {mode === 'create' ? (
            <div className="space-y-1.5 text-sm">
              <label htmlFor="managed-user-username" className="block font-medium">
                账号
              </label>
              <Input
                id="managed-user-username"
                value={username}
                onChange={(event) => setUsername(event.currentTarget.value)}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                minLength={3}
                maxLength={32}
                pattern={USERNAME_PATTERN}
                placeholder="例如 designer-01"
                autoFocus
                disabled={mutation.isPending}
              />
              <p className="text-xs text-muted-foreground">3–32 位，保存时自动转为小写</p>
            </div>
          ) : null}
          <div className="space-y-1.5 text-sm">
            <label htmlFor="managed-user-password" className="block font-medium">
              {mode === 'create' ? '初始密码' : '新密码'}
            </label>
            <Input
              id="managed-user-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.currentTarget.value)}
              autoComplete="new-password"
              minLength={8}
              maxLength={128}
              placeholder="至少 8 位"
              autoFocus={mode === 'reset'}
              disabled={mutation.isPending}
            />
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
              onClick={() => onOpenChange(false)}
              disabled={mutation.isPending}
            >
              取消
            </Button>
            <Button
              type="submit"
              disabled={
                mutation.isPending ||
                password.length < 8 ||
                (mode === 'create' && username.trim().length < 3)
              }
            >
              {mutation.isPending ? '保存中…' : mode === 'create' ? '创建账号' : '保存新密码'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
