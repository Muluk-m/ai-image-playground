import { useCloudGenerations } from '../hooks/useCloudGenerations'
import { useTranslation } from '../i18n'
import { isClientCapabilityEnabled } from '../lib/clientCapabilities'
import TaskGrid from './TaskGrid'

const RECENT_LIMIT = 12

/**
 * 生图入口的记录：只摆最近几条，搜索、状态筛选与批量操作在作品入口。
 * 平台记录也在这里拉一次并镜像成本机记录，否则另一台设备产的生成要先去作品页才看得到。
 */
export default function RecentGenerations({ userId }: { userId?: string }) {
  const { t } = useTranslation('task')
  useCloudGenerations(Boolean(userId) && isClientCapabilityEnabled('accounts:sync'))
  return (
    <>
      <p className="px-1 pb-3 pt-6 text-xs text-muted-foreground">{t('grid.recent')}</p>
      <TaskGrid limit={RECENT_LIMIT} />
    </>
  )
}
