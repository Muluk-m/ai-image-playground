import { useCallback, useEffect, useRef, useState } from 'react'
import MediaImage from '../../../components/MediaImage'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
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

export default function ProjectCover({
  source,
  chat,
  pending = false,
  fit = 'contain',
}: {
  source?: string
  chat: boolean
  pending?: boolean
  fit?: 'contain' | 'cover'
}) {
  const { t } = useTranslation('canvas')
  const retryRound = useCanvasProjectStore((state) => state.coverRetryRound)
  const [sentinel, near] = useNearViewport()
  const [attempt, setAttempt] = useState({ source, round: retryRound, auto: 0 })
  const [settled, setSettled] = useState<{ key: string; failed: boolean }>()
  const [timedOut, setTimedOut] = useState<string>()
  // 换了封面或点了「刷新项目」：从头再取，自动重试次数清零。
  if (attempt.source !== source || attempt.round !== retryRound)
    setAttempt({ source, round: retryRound, auto: 0 })
  const key = `${source ?? ''}#${attempt.round}#${attempt.auto}`
  const fail = useCallback(() => setSettled({ key, failed: true }), [key])
  const loaded = source !== undefined && settled?.key === key && !settled.failed
  const failed = source !== undefined && settled?.key === key && settled.failed
  const loading = source ? !loaded && !failed && timedOut !== key : pending
  useEffect(() => {
    if (!source || !near) return
    const timer = setTimeout(() => setTimedOut(key), PROJECT_COVER_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [source, near, key])
  useEffect(() => {
    if (!failed || attempt.auto > 0) return
    const timer = setTimeout(
      () => setAttempt((one) => (one.auto > 0 ? one : { ...one, auto: one.auto + 1 })),
      PROJECT_COVER_RETRY_MS,
    )
    return () => clearTimeout(timer)
  }, [failed, attempt.auto])
  const showImage = Boolean(source) && near
  return (
    <>
      <span ref={sentinel} aria-hidden="true" className="pointer-events-none absolute inset-0" />
      {showImage && source && (
        <>
          {fit === 'contain' && (
            <MediaImage
              key={`blur-${key}`}
              src={source}
              alt=""
              loading="lazy"
              aria-hidden="true"
              className={`absolute inset-0 h-full w-full scale-125 object-cover blur-2xl saturate-150 ${loaded ? 'opacity-50' : 'opacity-0'}`}
            />
          )}
          <MediaImage
            key={key}
            src={source}
            alt=""
            loading="lazy"
            data-project-cover-state={loaded ? 'loaded' : failed ? 'failed' : 'loading'}
            onLoad={() => setSettled({ key, failed: false })}
            onError={fail}
            onResolveError={fail}
            className={`relative h-full w-full ${fit === 'cover' ? 'object-cover' : 'object-contain'} ${loaded ? '' : 'opacity-0'}`}
          />
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
        !loaded && (
          <Icon name={chat ? 'chat' : 'image'} size="lg" className="text-muted-foreground" />
        )
      )}
    </>
  )
}
