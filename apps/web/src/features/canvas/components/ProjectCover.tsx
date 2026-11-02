import { useCallback, useEffect, useRef, useState } from 'react'
import MediaImage from '../../../components/MediaImage'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import { invalidateMediaPreview, mediaIdentity } from '../../../lib/cloudMedia'
import { bffBaseUrl } from '../../../lib/runtimeConfig'
import { useCanvasProjectStore } from '../projectStore'

/** 封面迟迟没出来就先收起转圈、换成图标；之后真加载到了照样换成图片。 */
export const PROJECT_COVER_TIMEOUT_MS = 20_000
/** 失败后自动再取一次，仍失败就停在图标，等「刷新项目」再试。 */
export const PROJECT_COVER_RETRY_MS = 4_000

/**
 * 封面只在卡片进入（或接近）视口时才去取：全站媒体下载共用两个名额，项目一多，
 * 屏幕外的封面排在前面会让看得见的卡片一直转圈。
 */
function useNearViewport() {
  const ref = useRef<HTMLSpanElement>(null)
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    if (near) return
    const node = ref.current
    if (!node || typeof IntersectionObserver === 'undefined') {
      setNear(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true)
          observer.disconnect()
        }
      },
      { rootMargin: '200px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [near])
  return [ref, near] as const
}

/**
 * 云端视频直接走支持 Range 的 `/api/media/:id/content`，浏览器只按需取元数据和首帧。
 * 不能走 `resolveMediaSource`：它会把整段视频下载成 data URL 再缓存。
 */
export function videoCoverUrl(source: string): string {
  const id = mediaIdentity(source)
  return id ? `${bffBaseUrl()}/api/media/${id}/content` : source
}

/** 只出过视频的对话拿视频首帧当封面：只取元数据和第一帧，不自动播放。 */
function VideoFrame({
  src,
  className,
  onLoad,
  onError,
}: {
  src: string
  className: string
  onLoad: () => void
  onError: () => void
}) {
  return (
    <video
      src={`${videoCoverUrl(src)}#t=0.1`}
      muted
      playsInline
      preload="metadata"
      crossOrigin="use-credentials"
      aria-hidden="true"
      onLoadedData={onLoad}
      onError={onError}
      className={className}
    />
  )
}

export default function ProjectCover({
  source,
  chat,
  pending = false,
  fit = 'contain',
  video = false,
  summary,
}: {
  source?: string
  chat: boolean
  pending?: boolean
  fit?: 'contain' | 'cover'
  /** `source` 是视频：显示首帧。 */
  video?: boolean
  /** 没有封面的对话卡显示这段文字（首条消息摘要），不再只剩一个图标。 */
  summary?: string
}) {
  const { t } = useTranslation('canvas')
  const retryRound = useCanvasProjectStore((state) => state.coverRetryRound)
  const [sentinel, near] = useNearViewport()
  // 本次加载属于哪一轮「刷新项目」；只有没取到的封面才跟进新一轮，已显示的封面不重载。
  // 换了封面就从当前轮次重新开始。
  const [pinned, setPinned] = useState({ source, round: retryRound })
  const round = pinned.source === source ? pinned.round : retryRound
  const [autoRetry, setAutoRetry] = useState({ base: '', count: 0 })
  const [settled, setSettled] = useState<{ key: string; failed: boolean }>()
  const [timedOut, setTimedOut] = useState<string>()
  const base = `${source ?? ''}#${round}`
  const retries = autoRetry.base === base ? autoRetry.count : 0
  const key = `${base}#${retries}`
  const onResolveError = useCallback(() => setSettled({ key, failed: true }), [key])
  const onLoaded = useCallback(() => setSettled({ key, failed: false }), [key])
  const onImageError = useCallback(() => {
    const fail = () => setSettled({ key, failed: true })
    if (!source || !mediaIdentity(source)) return fail()
    // 预览可能已坏在缓存里：先丢掉它再算失败，之后的重试（自动或「刷新项目」）才会重新下载。
    void invalidateMediaPreview(source)
      .catch(() => {})
      .finally(fail)
  }, [key, source])
  const loaded = source !== undefined && settled?.key === key && !settled.failed
  const failed = source !== undefined && settled?.key === key && settled.failed
  const stalled = failed || (!loaded && timedOut === key)
  const loading = source ? !loaded && !stalled : pending
  useEffect(() => {
    if (pinned.source !== source || (stalled && retryRound !== round))
      setPinned({ source, round: pinned.source === source ? retryRound : round })
  }, [pinned.source, source, stalled, retryRound, round])
  useEffect(() => {
    if (!source || !near) return
    const timer = setTimeout(() => setTimedOut(key), PROJECT_COVER_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [source, near, key])
  useEffect(() => {
    if (!failed || retries > 0) return
    const timer = setTimeout(() => setAutoRetry({ base, count: 1 }), PROJECT_COVER_RETRY_MS)
    return () => clearTimeout(timer)
  }, [failed, retries, base])
  const showImage = Boolean(source) && near
  return (
    <>
      <span ref={sentinel} aria-hidden="true" className="pointer-events-none absolute inset-0" />
      {showImage && source && (
        <>
          {fit === 'contain' && !video && (
            <MediaImage
              key={`blur-${key}`}
              src={source}
              alt=""
              loading="lazy"
              aria-hidden="true"
              className={`absolute inset-0 h-full w-full scale-125 object-cover blur-2xl saturate-150 ${loaded ? 'opacity-50' : 'opacity-0'}`}
            />
          )}
          {video ? (
            <VideoFrame
              key={key}
              src={source}
              onLoad={onLoaded}
              onError={onResolveError}
              className={`relative h-full w-full ${fit === 'cover' ? 'object-cover' : 'object-contain'} ${loaded ? '' : 'opacity-0'}`}
            />
          ) : (
            <MediaImage
              key={key}
              src={source}
              alt=""
              loading="lazy"
              data-project-cover-state={loaded ? 'loaded' : failed ? 'failed' : 'loading'}
              onLoad={onLoaded}
              onError={onImageError}
              onResolveError={onResolveError}
              className={`relative h-full w-full ${fit === 'cover' ? 'object-cover' : 'object-contain'} ${loaded ? '' : 'opacity-0'}`}
            />
          )}
        </>
      )}
      {loading ? (
        <span
          role="status"
          aria-label={t('sync.loading')}
          className="absolute inset-0 flex items-center justify-center"
        >
          <Icon
            name="loading"
            size="lg"
            className="animate-spin text-muted-foreground motion-reduce:animate-none"
          />
        </span>
      ) : (
        !loaded &&
        (chat && summary ? (
          <span className="line-clamp-4 w-full self-start px-4 pt-4 text-left text-sm leading-relaxed text-muted-foreground">
            {summary}
          </span>
        ) : (
          <Icon name={chat ? 'chat' : 'image'} size="lg" className="text-muted-foreground" />
        ))
      )}
    </>
  )
}
