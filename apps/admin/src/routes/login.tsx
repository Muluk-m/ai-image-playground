import { createFileRoute } from '@tanstack/react-router'

// Section 7 落地完整登录表单。
export const Route = createFileRoute('/login')({
  component: () => <div className="p-8 text-muted-foreground">login (Section 7)</div>,
})
