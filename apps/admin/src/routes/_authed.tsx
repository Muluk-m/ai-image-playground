import { Outlet, createFileRoute } from '@tanstack/react-router'

// Section 6 接 beforeLoad /api/me 鉴权守卫；现在仅做 layout passthrough。
export const Route = createFileRoute('/_authed')({
  component: () => <Outlet />,
})
