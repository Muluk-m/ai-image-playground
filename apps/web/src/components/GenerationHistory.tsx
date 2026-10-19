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

/** 本机与平台作品共用时间线；首页按滚动位置续读平台游标。 */
export default function GenerationHistory({ userId, hero }: { userId?: string; hero?: boolean }) {
  const { t } = useTranslation(['task', 'errors'])
  const hasWorks = useStore((s) => s.tasks.length > 0 || s.platformGenerations.length > 0)
  const cloud = useCloudGenerations(Boolean(userId) && isClientCapabilityEnabled('accounts:sync'))
  const endRef = useRef<HTMLDivElement>(null)
  const [atEnd, setAtEnd] = useState(false)
  const { hasMore, loading, failed, loadMore } = cloud

  useEffect(() => {
    const end = endRef.current
    if (!hero || !end || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return
        setAtEnd(entry.isIntersecting)
        if (entry.isIntersecting && hasMore && !loading && !failed) loadMore()
      },
      { rootMargin: '0px 0px 240px 0px' },
    )
    observer.observe(end)
    return () => observer.disconnect()
  }, [hero, hasMore, loading, failed, loadMore])

  const openLibrary = () => {
    useLibraryStore.getState().setTab('assets')
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
      <div className="relative">
        <TaskGrid hero={hero} />
        {hero && <div ref={endRef} className="h-px" aria-hidden="true" />}
        {hero && hasWorks && (!atEnd || hasMore) && (
          <div className="studio-works-fade" aria-hidden="true" />
        )}
      </div>
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
