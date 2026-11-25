import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Eye, EyeOff, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'

import { DangerConfirmDialog } from '@/components/DangerConfirmDialog'
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
import { refreshUserKpis } from '@/lib/queries'
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
    if (code === 'username_taken') return '该用户名已存在'
    if (code === 'invalid_username') return '用户名仅支持 3–32 位小写字母、数字、点、横线和下划线'
    if (code === 'invalid_password') return '密码长度需为 8–128 位'
    if (code === 'user_not_found') return '用户不存在或已被删除'
  }
  return '操作失败，请稍后重试'
}

export function UserFormDialog({ mode, user, open, onOpenChange }: UserFormDialogProps) {
  const queryClient = useQueryClient()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (!open) return
    setUsername('')
    setPassword('')
    setShowPassword(false)
    setError(null)
    setConfirming(false)
  }, [open])

  const mutation = useMutation({
    mutationFn: async (reason?: string) => {
      if (mode === 'create') {
        return apiClient.post('/api/users', { username, password })
      }
      if (!user) throw new Error('missing user')
      return apiClient.post(`/api/users/${encodeURIComponent(user.id)}/reset-password`, {
        password,
        reason,
      })
    },
    onSuccess: async () => {
      setConfirming(false)
      await queryClient.invalidateQueries({ queryKey: ['users'] })
      if (!user) await refreshUserKpis(queryClient)
      if (user) await queryClient.invalidateQueries({ queryKey: ['user', user.id] })
      onOpenChange(false)
    },
    onError: (mutationError) => setError(messageForError(mutationError)),
  })

  const title = mode === 'create' ? '创建用户' : `重置 ${user?.username ?? ''} 的密码`
  const description =
    mode === 'create'
      ? '用户创建后立即可用于经营站点登录。'
      : '保存后该用户的所有现有登录会话会立即失效。'

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && mutation.isPending) return
        onOpenChange(next)
      }}
    >
      <DialogContent
        onEscapeKeyDown={(event) => {
          if (mutation.isPending) event.preventDefault()
        }}
        onPointerDownOutside={(event) => {
          if (mutation.isPending) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            setError(null)
            if (mode === 'reset') {
              setConfirming(true)
              return
            }
            mutation.mutate(undefined)
          }}
        >
          {mode === 'create' ? (
            <div className="space-y-1.5 text-sm">
              <label htmlFor="managed-user-username" className="block font-medium">
                用户名
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
            <div className="relative">
              <Input
                id="managed-user-password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(event) => {
                  setPassword(event.currentTarget.value)
                  if (error) setError(null)
                }}
                autoComplete="new-password"
                minLength={8}
                maxLength={128}
                placeholder="至少 8 位"
                autoFocus={mode === 'reset'}
                disabled={mutation.isPending}
                className="pr-9"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={showPassword ? '隐藏密码' : '显示密码'}
                className="absolute right-1.5 top-1/2 h-7 w-7 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                disabled={mutation.isPending}
                onClick={() => setShowPassword((prev) => !prev)}
              >
                {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </Button>
            </div>
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
              aria-busy={mutation.isPending}
              disabled={
                mutation.isPending ||
                password.length < 8 ||
                (mode === 'create' && username.trim().length < 3)
              }
            >
              {mutation.isPending ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              ) : null}
              {mutation.isPending ? '保存中…' : mode === 'create' ? '创建用户' : '保存新密码'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
      {mode === 'reset' && user ? (
        <DangerConfirmDialog
          open={confirming}
          onOpenChange={(nextOpen) => {
            setConfirming(nextOpen)
            if (!nextOpen) setError(null)
          }}
          title={`重置 ${user.username} 的密码?`}
          impact="保存后该用户的所有现有登录会话会立即失效。"
          confirmLabel="确认重置"
          pending={mutation.isPending}
          error={error}
          onConfirm={(reason) => {
            setError(null)
            mutation.mutate(reason)
          }}
        />
      ) : null}
    </Dialog>
  )
}
