import { useState } from 'react'
import { useCloudGenerations } from '../hooks/useCloudGenerations'
import { useTranslation } from '../i18n'
import { isClientCapabilityEnabled } from '../lib/clientCapabilities'
import { useStore } from '../store'
import SearchBar from './SearchBar'
import SectionHeader from './SectionHeader'
import TaskGrid from './TaskGrid'
import { Button } from './ui/button'

/**
 * 作品页。**一条列表、一种卡**：只在平台留有记录的生成被镜像成本机任务记录（`lib/cloudMirror`），
 * 和本机生成穿插在同一个网格里。不分「此设备 / 云端」两个页签——那是存储位置，不是用户要挑的东西。
 *
 * 平台记录按游标往后读，所以底部是「加载更多」而不是翻页；本机任务不分页，翻页会把两边的
 * 时间线切断。
 */
export default function GenerationHistory({ userId, hero }: { userId?: string; hero?: boolean }) {
  const { t } = useTranslation(['task', 'errors'])
  const [showAll, setShowAll] = useState(false)
  // 冷启动时下面是灵感区，它自带标题；「我的作品」空着挂一个标题只会像没加载出来。
  const hasWorks = useStore((s) => s.tasks.length > 0 || s.platformGenerations.length > 0)
  const cloud = useCloudGenerations(Boolean(userId) && isClientCapabilityEnabled('accounts:sync'))
  return (
    <>
      {!hero && <SearchBar />}
      {/* 展开着删光作品时仍留住标题，否则搜索与「收起」一起消失，退不出筛选态。 */}
      {hero && (hasWorks || showAll) && (
        <SectionHeader
          className="pb-4 pt-10"
          title={t('grid.mine')}
          action={{
            label: showAll ? t('grid.collapse') : t('grid.viewAll'),
            onClick: () => setShowAll((value) => !value),
            expanded: showAll,
          }}
        >
          {showAll && (
            <div className="w-full sm:w-auto sm:max-w-xl sm:flex-1">
              <SearchBar compact />
            </div>
          )}
        </SectionHeader>
      )}
      <TaskGrid hero={hero} limit={hero && !showAll ? 3 : undefined} />
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
      {cloud.hasMore && (!hero || showAll) && (
        <div className="flex justify-center pb-10">
          <Button variant="outline" disabled={cloud.loading} onClick={cloud.loadMore}>
            {cloud.loading ? t('cloudHistory.loading') : t('cloudHistory.more')}
          </Button>
        </div>
      )}
    </>
  )
}
