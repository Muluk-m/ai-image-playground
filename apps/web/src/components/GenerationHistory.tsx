import { useCloudGenerations } from '../hooks/useCloudGenerations'
import { BRAND_WORDMARK, brandNeedsWordmark, useTranslation } from '../i18n'
import { isClientCapabilityEnabled } from '../lib/clientCapabilities'
import { useStore } from '../store'
import InputBar from './InputBar'
import SearchBar from './SearchBar'
import TaskGrid from './TaskGrid'
import { Button } from './ui/button'

/**
 * 作品页。**一条列表**：本机任务与只在平台留有记录的生成按时间穿插，不分「此设备 / 云端」
 * 两个页签——那是存储位置，不是用户要挑的东西。同一条生成两边都有时只显示本机那张卡。
 *
 * 平台记录按游标往后读，所以底部是「加载更多」而不是翻页；本机任务不分页，翻页会把两边的
 * 时间线切断。
 *
 * 输入框归这里管，因为只有这里同时知道本机任务和平台记录空不空：一条作品都没有时它顶在
 * 页面上方（否则浮动输入框会压住灵感探索那一排），有作品之后浮回底部。
 */
export default function GenerationHistory({ userId }: { userId?: string }) {
  const { t } = useTranslation(['task', 'errors', 'shell'])
  const cloud = useCloudGenerations(Boolean(userId) && isClientCapabilityEnabled('accounts:sync'))
  const taskCount = useStore((s) => s.tasks.length)
  const galleryEmpty = taskCount === 0 && cloud.items.length === 0
  return (
    <>
      {galleryEmpty && (
        <div className="flex flex-col items-center gap-2 pt-10 pb-5 sm:pt-14">
          <div className="flex items-center gap-2.5">
            <img src="/brand/muvloom-icon.svg" alt="" width="32" height="32" aria-hidden />
            <span className="font-display text-xl font-medium tracking-tight sm:text-2xl">
              {t('shell:header.brandName')}
              {brandNeedsWordmark() ? (
                <span className="ml-2 text-muted-foreground">{BRAND_WORDMARK}</span>
              ) : null}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">{t('shell:home.tagline')}</p>
        </div>
      )}
      {/* docked 形态是 fixed，不占位，所以两种形态共用这一个挂载点。 */}
      <InputBar placement={galleryEmpty ? 'hero' : 'docked'} />
      {!galleryEmpty && <SearchBar />}
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
      {/* 给浮动输入框留出的落脚位；顶部形态不需要，免得空画廊下面拖一大片空白。 */}
      {!galleryEmpty && <div aria-hidden className="studio-history-composer-spacer" />}
    </>
  )
}
