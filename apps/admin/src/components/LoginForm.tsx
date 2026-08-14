import { useMutation } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ApiError, apiClient } from '@/lib/api-client'

export interface LoginFormProps {
  onSuccess: () => void
}

export function LoginForm({ onSuccess }: LoginFormProps) {
  const [password, setPassword] = useState('')

  const mutation = useMutation({
    mutationFn: (pw: string) => apiClient.post<{ ok: true }>('/api/login', { password: pw }),
    onSuccess,
  })

  const errorText = computeErrorText(mutation.error)

  function onSubmit(e: React.FormEvent<HTMLFormElement>): void {
    e.preventDefault()
    if (!password) return
    mutation.mutate(password)
  }

  return (
    <form
      onSubmit={onSubmit}
      className="w-full max-w-sm space-y-4 rounded-lg border bg-card p-6 shadow-sm"
      aria-label="登录"
    >
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">登录</h1>
        <p className="text-xs text-muted-foreground">image-playground · admin</p>
      </div>
      <Input
        type="password"
        placeholder="密码"
        autoFocus
        autoComplete="current-password"
        aria-label="密码"
        value={password}
        onChange={(e) => setPassword(e.currentTarget.value)}
        disabled={mutation.isPending}
      />
      {errorText ? (
        <p role="alert" className="text-xs text-destructive">
          {errorText}
        </p>
      ) : null}
      <Button
        type="submit"
        className="w-full"
        disabled={mutation.isPending || password.length === 0}
      >
        {mutation.isPending ? <Loader2 className="animate-spin" /> : null}
        登录
      </Button>
    </form>
  )
}

function computeErrorText(err: unknown): string | null {
  if (!err) return null
  if (err instanceof ApiError) {
    const body = err.body as { error?: string } | null
    if (body?.error === 'rate_limited' || err.status === 429) {
      return '登录过于频繁，请稍后再试'
    }
    if (body?.error === 'invalid_password' || err.status === 401) {
      return '密码错误'
    }
  }
  return '登录失败，请稍后再试'
}
