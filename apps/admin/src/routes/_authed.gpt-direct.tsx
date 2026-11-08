import { createFileRoute, redirect } from '@tanstack/react-router'

/** 旧入口：直连密钥与预算已并入「供应商」页。 */
export const Route = createFileRoute('/_authed/gpt-direct')({
  validateSearch: (search: Record<string, unknown>) => ({
    days: search.days === '30' || search.days === 30 ? (30 as const) : (7 as const),
  }),
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/providers', search: { tab: 'direct', days: search.days } })
  },
})
