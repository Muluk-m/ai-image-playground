import { useQuery } from '@tanstack/react-query'

import { LoginForm } from '@/components/LoginForm'
import { Button } from '@/components/ui/button'
import { loginMethodsQueryOptions } from '@/lib/admin-session'

export type LoginErrorCode = 'not_allowed' | 'oauth_failed'

export interface LoginPanelProps {
  redirectTo?: string
  error?: LoginErrorCode
  onSuccess: () => void
}

const ERROR_TEXT: Record<LoginErrorCode, string> = {
  not_allowed: '这个 Google 账号没有权限',
  oauth_failed: '登录失败，请重试',
}

export function LoginPanel({ redirectTo, error, onSuccess }: LoginPanelProps) {
  const methods = useQuery(loginMethodsQueryOptions)

  if (methods.isPending) return null
  // An unreachable endpoint falls back to the password form the deployment had before.
  if (!methods.data?.google_login) return <LoginForm onSuccess={onSuccess} />

  const href = redirectTo
    ? `/api/auth/google?redirect=${encodeURIComponent(redirectTo)}`
    : '/api/auth/google'

  return (
    <div className="w-full max-w-sm space-y-4 rounded-lg border bg-card p-6 shadow-sm">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">登录</h1>
        <p className="text-xs text-muted-foreground">image-playground · admin</p>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {ERROR_TEXT[error]}
        </p>
      ) : null}
      <Button asChild className="w-full">
        <a href={href}>使用 Google 登录</a>
      </Button>
    </div>
  )
}
