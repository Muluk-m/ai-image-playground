import { createFileRoute, redirect } from '@tanstack/react-router'

/** 旧入口：供应商、模型与密钥已合并到「供应商」。 */
export const Route = createFileRoute('/_authed/upstream-secrets')({
  beforeLoad: () => {
    throw redirect({ to: '/providers', search: { tab: 'secrets' } })
  },
})
