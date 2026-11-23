import { createFileRoute, redirect } from '@tanstack/react-router'

/** 旧入口：Provider 与模型设置已并入「模型与计费 / 模型与网关」。 */
export const Route = createFileRoute('/_authed/agent-models')({
  beforeLoad: () => {
    throw redirect({ to: '/providers', search: { tab: 'routing' } })
  },
})
