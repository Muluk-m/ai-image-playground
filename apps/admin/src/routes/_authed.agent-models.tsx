import { createFileRoute, redirect } from '@tanstack/react-router'

/** 旧入口：Provider 与模型设置已并入「供应商」。 */
export const Route = createFileRoute('/_authed/agent-models')({
  beforeLoad: () => {
    throw redirect({ to: '/providers' })
  },
})
