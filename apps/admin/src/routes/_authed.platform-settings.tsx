import { createFileRoute, redirect } from '@tanstack/react-router'
import { Page } from '@/components/Page'
import { OperatorSettingsPanel } from '@/features/platform-settings/OperatorSettingsPanel'

export const Route = createFileRoute('/_authed/platform-settings')({
  validateSearch: (search: Record<string, unknown>): { tab?: 'models' | 'settings' } => ({
    tab: search.tab === 'models' ? 'models' : undefined,
  }),
  beforeLoad: ({ search }) => {
    if (search.tab === 'models') {
      throw redirect({ to: '/providers', search: { tab: 'models' } })
    }
  },
  component: PlatformSettingsPage,
})

function PlatformSettingsPage() {
  return (
    <Page crumbs={[{ label: '平台配置' }]}>
      <OperatorSettingsPanel />
    </Page>
  )
}
