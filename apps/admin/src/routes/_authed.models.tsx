import { createFileRoute, redirect } from '@tanstack/react-router'

/** 旧入口：生成模型已并入「平台配置」。 */
export const Route = createFileRoute('/_authed/models')({
  validateSearch: (search: Record<string, unknown>) => ({
    tab: search.tab === 'chat' ? ('chat' as const) : undefined,
  }),
  beforeLoad: ({ search }) => {
    if (search.tab === 'chat') throw redirect({ to: '/providers' })
    throw redirect({ to: '/platform-settings', search: { tab: 'models' } })
  },
})
