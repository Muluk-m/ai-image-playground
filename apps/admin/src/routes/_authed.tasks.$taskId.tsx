import { createFileRoute } from '@tanstack/react-router'

// Section 11 落地完整 deeplink redirect。
export const Route = createFileRoute('/_authed/tasks/$taskId')({
  component: () => <div className="p-8 text-muted-foreground">task redirect (Section 11)</div>,
})
