import { useCloudGenerations } from '../hooks/useCloudGenerations'
import { useTranslation } from '../i18n'
import { isClientCapabilityEnabled } from '../lib/clientCapabilities'
import SearchBar from './SearchBar'
import TaskGrid from './TaskGrid'
import { Button } from './ui/button'

/**
 * 作品页。**一条列表**：本机任务与只在平台留有记录的生成按时间穿插，不分「此设备 / 云端」
 * 两个页签——那是存储位置，不是用户要挑的东西。同一条生成两边都有时只显示本机那张卡。
 *
 * 平台记录按游标往后读，所以底部是「加载更多」而不是翻页；本机任务不分页，翻页会把两边的
 * 时间线切断。
 */
export default function GenerationHistory({ userId }: { userId?: string }) {
  const { t } = useTranslation(['task', 'errors'])
  const cloud = useCloudGenerations(Boolean(userId) && isClientCapabilityEnabled('accounts:sync'))
  return (
    <>
      <SearchBar />
      <TaskGrid cloudItems={cloud.items} />
      {cloud.failed && (
        <div className="flex items-center justify-center gap-3 pb-8">
          <p role="alert" className="text-sm text-destructive">
            {t('errors:generations.fallback')}
          </p>
          <Button variant="outline" onClick={cloud.reload}>
            {t('cloudHistory.refresh')}
          </Button>
        </div>
      )}
      {cloud.hasMore && (
        <div className="flex justify-center pb-10">
          <Button variant="outline" disabled={cloud.loading} onClick={cloud.loadMore}>
            {cloud.loading ? t('cloudHistory.loading') : t('cloudHistory.more')}
          </Button>
        </div>
      )}
    </>
  )
}
