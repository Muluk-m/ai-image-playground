import { createFileRoute } from '@tanstack/react-router'

// Section 8 落地完整列表。
export const Route = createFileRoute('/_authed/devices/')({
  component: () => <div className="p-8 text-muted-foreground">devices (Section 8)</div>,
})
