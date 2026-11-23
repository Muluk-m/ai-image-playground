import { createFileRoute, redirect } from '@tanstack/react-router'

/** 旧入口：对话与生成模型均已统一并入 `/providers`（「模型与计费」/「模型与网关」）。 */
export const Route = createFileRoute('/_authed/models')({
  validateSearch: (search: Record<string, unknown>) => ({
    tab: search.tab === 'chat' ? ('chat' as const) : undefined,
  }),
  beforeLoad: ({ search }) => {
    if (search.tab === 'chat') {
      throw redirect({ to: '/providers', search: { tab: 'models', kind: 'chat' } })
    }
    throw redirect({ to: '/providers', search: { tab: 'models' } })
  },
})
