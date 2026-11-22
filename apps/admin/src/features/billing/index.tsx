import type { PrivateAdminOverlay } from '../../lib/private-overlay'
import { ModelPricing } from './ModelPricing'
import { OrdersPanel } from './OrdersPanel'
import { OverviewPanel } from './OverviewPanel'
import { SettingsPanel } from './SettingsPanel'
import { useUserSummaries } from './summaries'
import { UserDetailPanel } from './UserDetailPanel'
export const privateAdminOverlay: PrivateAdminOverlay & { userDetailProfile: true } = {
  present: true,
  userSummaryColumnTitle: '积分 / 套餐',
  useUserSummaries,
  OverviewPanel,
  SettingsPanel,
  OrdersPanel,
  ModelPricing,
  UserDetailPanel,
  userDetailProfile: true,
}

export default privateAdminOverlay
