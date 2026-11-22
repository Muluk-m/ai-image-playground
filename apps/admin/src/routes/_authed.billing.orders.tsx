import { createFileRoute } from '@tanstack/react-router'
import { PrivateAdminOrdersPanel, requirePrivateAdminRoute } from '@/lib/private-overlay'

export const Route = createFileRoute('/_authed/billing/orders')({
  beforeLoad: () => requirePrivateAdminRoute('/billing/orders'),
  component: PrivateAdminOrdersPanel,
})
