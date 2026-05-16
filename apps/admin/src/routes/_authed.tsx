import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'

import { apiClient } from '@/lib/api-client'

// 鉴权守卫：layout route，beforeLoad 探 /api/me（cookie 校验），失败 redirect /login。
// 用 ensureQueryData 走 queryClient cache 避免每次 prefetch 都打一次后端。
export const Route = createFileRoute('/_authed')({
  beforeLoad: async ({ context, location }) => {
    try {
      await context.queryClient.ensureQueryData({
        queryKey: ['me'],
        queryFn: () => apiClient.get<{ ok: true }>('/api/me'),
        staleTime: 60_000, // 1 分钟内不重复探
      })
    } catch {
      throw redirect({
        to: '/login',
        search: { redirect: location.pathname + location.searchStr },
      })
    }
  },
  component: () => <Outlet />,
})
