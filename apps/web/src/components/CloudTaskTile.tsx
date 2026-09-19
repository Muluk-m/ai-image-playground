import type { GenerationDetail, GenerationSummary } from '@image-playground/shared'
import { useState } from 'react'
import { useTranslation } from '../i18n'
import { authenticatedBffFetch } from '../lib/authClient'
import { bffBaseUrl } from '../lib/runtimeConfig'
import CloudGenerationDetail from './CloudGenerationDetail'
import MediaImage from './MediaImage'
import Overlay from './Overlay'

/**
 * 作品列表里只在平台留有记录、本机已经没有的那条生成。
 *
 * 和本机任务卡同一个网格、同一种尺寸——作品页不区分「此设备」和「云端」，用户看到的是一条
 * 时间线。差别只在能做什么：这条记录本机没有原始参数和输出图，所以只给详情，不给复用 /
 * 放入画布 / 删除。
 */
export default function CloudTaskTile({ item }: { item: GenerationSummary }) {
  const { t, i18n } = useTranslation(['task', 'errors'])
  const [detail, setDetail] = useState<GenerationDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  const open = async () => {
    if (loading) return
    setLoading(true)
    setFailed(false)
    try {
      const response = await authenticatedBffFetch(
        `${bffBaseUrl()}/api/generations/${encodeURIComponent(item.id)}`,
        { cache: 'no-store' },
      )
      if (!response.ok) throw new Error('load_failed')
      setDetail(await response.json())
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }

  const status = t(
    item.archiveStatus === 'pending'
      ? 'cloudHistory.archiving'
      : `cloudHistory.status.${item.status}`,
  )
  return (
    <div className="task-card-wrapper">
      <button
        type="button"
        onClick={() => void open()}
        aria-label={t('cloudHistory.openAria', { model: item.model })}
        className="flex w-full flex-col overflow-hidden rounded-xl border border-border bg-card text-left transition-colors hover:border-ring/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {item.cover ? (
          <MediaImage
            src={`aip-media:${item.cover.mediaId}`}
            alt=""
            loading="lazy"
            className="aspect-square w-full bg-muted object-cover"
          />
        ) : (
          <span className="grid aspect-square w-full place-items-center bg-muted text-xs text-muted-foreground">
            {status}
          </span>
        )}
        <span className="flex items-center justify-between gap-2 px-3 py-2.5">
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{item.model}</span>
            <time
              dateTime={new Date(item.createdAt).toISOString()}
              className="block text-xs text-muted-foreground"
            >
              {new Date(item.createdAt).toLocaleString(i18n.language)}
            </time>
          </span>
          <span className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-[11px] text-muted-foreground">
            {loading ? t('cloudHistory.loading') : status}
          </span>
        </span>
      </button>
      {failed && (
        <p role="alert" className="mt-1 px-1 text-[11px] text-destructive">
          {t('errors:generations.fallback')}
        </p>
      )}
      {detail && (
        <Overlay onClose={() => setDetail(null)}>
          <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-card p-5">
            <CloudGenerationDetail key={detail.id} detail={detail} />
            <button
              type="button"
              className="mt-4 min-h-11 w-full rounded-xl bg-muted text-sm"
              onClick={() => setDetail(null)}
            >
              {t('cloudHistory.close')}
            </button>
          </div>
        </Overlay>
      )}
    </div>
  )
}
