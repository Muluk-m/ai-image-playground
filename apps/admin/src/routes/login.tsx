import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'

import { type LoginErrorCode, LoginPanel } from '@/components/LoginPanel'
import { adminSessionQueryOptions } from '@/lib/admin-session'

const LOGIN_ERROR_CODES: readonly LoginErrorCode[] = ['not_allowed', 'oauth_failed']

export interface LoginSearch {
  redirect?: string
  error?: LoginErrorCode
}

function parseLoginSearch(input: Record<string, unknown>): LoginSearch {
  const r = input.redirect
  const e = input.error
  return {
    ...(typeof r === 'string' && r.startsWith('/') ? { redirect: r } : {}),
    ...(LOGIN_ERROR_CODES.includes(e as LoginErrorCode) ? { error: e as LoginErrorCode } : {}),
  }
}

export const Route = createFileRoute('/login')({
  validateSearch: parseLoginSearch,
  beforeLoad: async ({ context }) => {
    // 已登录访问 /login → 跳 /devices；未登录则继续渲染表单。
    try {
      await context.queryClient.ensureQueryData(adminSessionQueryOptions)
      throw redirect({ to: '/devices' })
    } catch (err) {
      // 区分鉴权失败（继续渲染）与 router redirect（继续抛出）。
      if (err && (err as { isRedirect?: boolean }).isRedirect) throw err
      // ApiError / UnauthorizedError / 网络错误：都视为"未登录"，落到表单
    }
  },
  component: LoginPage,
})

function LoginPage() {
  const navigate = useNavigate()
  const { redirect: redirectTo, error } = Route.useSearch()

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <LoginPanel
        redirectTo={redirectTo}
        error={error}
        onSuccess={() => {
          void navigate({ to: redirectTo ?? '/devices' })
        }}
      />
    </div>
  )
}
