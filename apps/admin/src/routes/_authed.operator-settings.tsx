import { createFileRoute, redirect } from '@tanstack/react-router'

/** 旧入口：能力与配额已并入「平台配置」。 */
export const Route = createFileRoute('/_authed/operator-settings')({
  beforeLoad: () => {
    throw redirect({ to: '/platform-settings', search: { tab: 'settings' } })
  },
})
