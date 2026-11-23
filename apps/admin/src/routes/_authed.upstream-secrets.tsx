import { createFileRoute, redirect } from '@tanstack/react-router'

/** 旧入口：运行时密钥已并入「模型与计费 / 模型与网关 → 密钥池与预算」。 */
export const Route = createFileRoute('/_authed/upstream-secrets')({
  beforeLoad: () => {
    throw redirect({ to: '/providers', search: { tab: 'keys' } })
  },
})
