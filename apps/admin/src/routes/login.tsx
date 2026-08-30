import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'

import { LoginForm } from '@/components/LoginForm'
import { adminSessionQueryOptions } from '@/lib/admin-session'

export interface LoginSearch {
  redirect?: string
}

function parseLoginSearch(input: Record<string, unknown>): LoginSearch {
  const r = input.redirect
  return typeof r === 'string' && r.startsWith('/') ? { redirect: r } : {}
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
  const { redirect: redirectTo } = Route.useSearch()

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <LoginForm
        onSuccess={() => {
          void navigate({ to: redirectTo ?? '/devices' })
        }}
      />
    </div>
  )
}
