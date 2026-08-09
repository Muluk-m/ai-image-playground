import { createFileRoute } from '@tanstack/react-router'

import { PrivateAdminSettingsPanel, requirePrivateAdminRoute } from '@/lib/private-overlay'

export const Route = createFileRoute('/_authed/billing/settings')({
  beforeLoad: () => requirePrivateAdminRoute('/billing/settings'),
  component: PrivateAdminSettingsPanel,
})
