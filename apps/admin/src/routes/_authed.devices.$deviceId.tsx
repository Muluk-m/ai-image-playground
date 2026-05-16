import { createFileRoute } from '@tanstack/react-router'

// Section 9 落地完整详情。
export const Route = createFileRoute('/_authed/devices/$deviceId')({
  component: () => <div className="p-8 text-muted-foreground">device detail (Section 9)</div>,
})
