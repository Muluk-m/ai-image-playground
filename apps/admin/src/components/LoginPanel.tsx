import { useQuery } from '@tanstack/react-query'
import { LoginCard } from '@/components/LoginCard'
import { LoginForm } from '@/components/LoginForm'
import { Button } from '@/components/ui/button'
import { loginMethodsQueryOptions } from '@/lib/admin-session'
import type { LoginErrorCode } from '../../contracts'

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
    <LoginCard error={error ? ERROR_TEXT[error] : null}>
      <Button asChild className="w-full">
        <a href={href}>使用 Google 登录</a>
      </Button>
    </LoginCard>
  )
}
