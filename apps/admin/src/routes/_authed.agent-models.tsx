import { createFileRoute, redirect } from '@tanstack/react-router'

/** 旧入口：Agent 模型并进了「模型」页的对话模型。 */
export const Route = createFileRoute('/_authed/agent-models')({
  beforeLoad: () => {
    throw redirect({ to: '/models', search: { tab: 'chat' } })
  },
})
