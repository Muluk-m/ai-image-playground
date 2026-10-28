import { useEffect, useRef, useState } from 'react'
import { useLibraryStore } from '../features/library/store'
import { useCloudGenerations } from '../hooks/useCloudGenerations'
import { useTranslation } from '../i18n'
import { isClientCapabilityEnabled } from '../lib/clientCapabilities'
import { useStore } from '../store'
import SectionHeader from './patterns/SectionHeader'
import SearchBar from './SearchBar'
import TaskGrid from './TaskGrid'
import { Button } from './ui/button'

/** 本机与平台作品共用时间线；首页先预览最近两行，展开后按滚动续读平台游标。 */
export default function GenerationHistory({ userId, hero }: { userId?: string; hero?: boolean }) {
  const { t } = useTranslation(['task', 'errors'])
  const hasWorks = useStore((s) => s.tasks.length > 0 || s.platformGenerations.length > 0)
  const cloud = useCloudGenerations(Boolean(userId) && isClientCapabilityEnabled('accounts:sync'))
  // 首页先预览两行；点「查看全部作品」后展开成完整时间线，并按滚动续读平台游标。
  const [expanded, setExpanded] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)
  const { hasMore, loading, failed, loadMore } = cloud
  const paging = Boolean(hero) && expanded

  useEffect(() => {
    const end = endRef.current
    if (!paging || !end) return
    const updateEnd = (nearEnd: boolean) => {
      if (nearEnd && hasMore && !loading && !failed) loadMore()
    }
    if (typeof IntersectionObserver === 'undefined') {
      const checkEnd = () => updateEnd(end.getBoundingClientRect().top <= window.innerHeight + 240)
      window.addEventListener('scroll', checkEnd, { passive: true })
      window.addEventListener('resize', checkEnd)
      checkEnd()
      return () => {
        window.removeEventListener('scroll', checkEnd)
        window.removeEventListener('resize', checkEnd)
      }
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry) updateEnd(entry.isIntersecting)
      },
      { rootMargin: '0px 0px 240px 0px' },
    )
    observer.observe(end)
    return () => observer.disconnect()
  }, [paging, hasMore, loading, failed, loadMore])

  const openLibrary = () => {
    // 「我的作品」来的人要找的是生成的图：落到能看到对话 / 画布封面的「项目」，不是空的素材页（BUG-18）。
    useLibraryStore.getState().setTab('projects')
    useStore.getState().setAppMode('library')
  }
  return (
    <>
      {!hero && <SearchBar />}
      {hero && hasWorks && (
        <SectionHeader
          className="pb-4 pt-10"
          title={t('grid.mine')}
          link={{ label: t('grid.openLibrary'), onClick: openLibrary }}
        />
      )}
      <TaskGrid
        hero={hero}
        preview={Boolean(hero) && !expanded}
        moreAvailable={hasMore}
        onShowAll={() => setExpanded(true)}
      />
      {paging && <div ref={endRef} className="h-px" aria-hidden="true" />}
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
      {hero && cloud.loading && (
        <p role="status" className="pb-8 text-center text-sm text-muted-foreground">
          {t('cloudHistory.loading')}
        </p>
      )}
      {cloud.hasMore && !hero && (
        <div className="flex justify-center pb-10">
          <Button variant="outline" disabled={cloud.loading} onClick={cloud.loadMore}>
            {cloud.loading ? t('cloudHistory.loading') : t('cloudHistory.more')}
          </Button>
        </div>
      )}
    </>
  )
}
