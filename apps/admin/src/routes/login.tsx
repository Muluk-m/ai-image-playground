import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { LoginPanel } from '@/components/LoginPanel'
import { adminSessionQueryOptions, loginMethodsQueryOptions } from '@/lib/admin-session'
import { LOGIN_ERROR_CODES, type LoginErrorCode } from '../../contracts'

function isLoginErrorCode(value: unknown): value is LoginErrorCode {
  return LOGIN_ERROR_CODES.includes(value as LoginErrorCode)
}

export interface LoginSearch {
  redirect?: string
  error?: LoginErrorCode
}

function parseLoginSearch(input: Record<string, unknown>): LoginSearch {
  const r = input.redirect
  // `//host` would leave the console entirely.
  const redirect = typeof r === 'string' && r.startsWith('/') && !r.startsWith('//') ? r : undefined
  return { redirect, error: isLoginErrorCode(input.error) ? input.error : undefined }
}

export const Route = createFileRoute('/login')({
  validateSearch: parseLoginSearch,
  beforeLoad: async ({ context }) => {
    // 与下面的登录态探测并行，避免登录页多等一个来回。
    void context.queryClient.prefetchQuery(loginMethodsQueryOptions)
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
