import { useEffect, useRef, useState } from 'react'
import { Button } from '../../ui/button'
import { Icon } from '../../ui/icon'

const PLAYER_MAX_HEIGHT = 'min(24rem, 46vh)'

export function playerFrameStyle(aspectRatio: string): {
  aspectRatio: string
  width: string
  maxHeight: string
} {
  const [width, height] = aspectRatio.split('/').map((part) => Number(part))
  const capped =
    Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
      ? `min(100%, calc(${PLAYER_MAX_HEIGHT} * ${width} / ${height}))`
      : '100%'
  return { aspectRatio, width: capped, maxHeight: PLAYER_MAX_HEIGHT }
}

/** Load visible results before the first click; keep offscreen history from competing for bandwidth. */
export function VideoPlayer({
  src,
  poster,
  label,
  errorLabel,
  retryLabel,
  loadingLabel,
  onFrameReady,
  onAspectRatioChange,
  aspectRatio = '16 / 9',
  fill = false,
  crossOrigin = 'use-credentials',
}: {
  src: string
  poster?: string
  label: string
  errorLabel: string
  retryLabel: string
  loadingLabel: string
  onFrameReady?: (video: HTMLVideoElement) => void
  onAspectRatioChange?: (aspectRatio: string) => void
  aspectRatio?: string
  fill?: boolean
  /** Public media without CORS support can opt out; authenticated media keeps credentials. */
  crossOrigin?: 'anonymous' | 'use-credentials' | null
}) {
  const frame = useRef<HTMLDivElement>(null)
  const media = useRef<HTMLVideoElement>(null)
  const [nearViewport, setNearViewport] = useState(false)
  const [playingSource, setPlayingSource] = useState<string | null>(null)
  const position = useRef({ src, time: 0 })
  const capturedSource = useRef<string | null>(null)
  const posterSeek = useRef<string | null>(null)
  const loadMedia = nearViewport || playingSource === src
  let preload: 'none' | 'metadata' | 'auto' = 'none'
  if (playingSource === src) preload = 'auto'
  else if (nearViewport) preload = 'metadata'
  const [failure, setFailure] = useState<string | null>(null)
  const [ready, setReady] = useState<string | null>(null)
  const [waiting, setWaiting] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [dimensions, setDimensions] = useState<{ src: string; ratio: string }>()
  const displayRatio = dimensions?.src === src ? dimensions.ratio : aspectRatio
  const frameStyle = playerFrameStyle(displayRatio)
  const loading = loadMedia && failure !== src && (ready !== src || waiting)
  useEffect(() => {
    if (!loading) return
    const timer = window.setTimeout(() => {
      setFailure(src)
      setWaiting(false)
    }, 45_000)
    return () => window.clearTimeout(timer)
  }, [src, attempt, loading])
  useEffect(() => {
    const node = frame.current
    if (!node) return
    if (typeof IntersectionObserver === 'undefined') {
      setNearViewport(true)
      return
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        setNearViewport(entry.isIntersecting)
      },
      { rootMargin: '0px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const video = media.current
    // StrictMode 会重放 setup/cleanup；清理过的同一节点需要重新接上来源。
    if (loadMedia && video && video.getAttribute('src') !== src) {
      video.src = src
      video.load()
    }
    if (!loadMedia) {
      setReady(null)
      setWaiting(false)
    }
    return () => {
      posterSeek.current = null
      if (!video) return
      video.pause()
      video.removeAttribute('src')
      video.load()
    }
  }, [src, attempt, loadMedia])
  return (
    <div
      ref={frame}
      data-slot="video-player"
      className={
        fill
          ? 'relative w-full overflow-hidden bg-black'
          : 'relative max-w-full self-start overflow-hidden rounded-xl bg-black'
      }
      style={{ ...frameStyle, width: fill ? '100%' : frameStyle.width }}
    >
      <video
        ref={media}
        key={`${src}:${attempt}`}
        src={loadMedia ? src : undefined}
        poster={poster}
        controls
        playsInline
        crossOrigin={crossOrigin ?? undefined}
        preload={preload}
        aria-label={label}
        className="absolute inset-0 h-full w-full bg-black object-contain"
        onError={() => {
          posterSeek.current = null
          setFailure(src)
          setWaiting(false)
        }}
        onLoadedData={(event) => {
          setFailure(null)
          setReady(src)
          setWaiting(
            !event.currentTarget.paused &&
              event.currentTarget.readyState < HTMLMediaElement.HAVE_FUTURE_DATA,
          )
          // A loadeddata event can precede the decoder's painted frame. Seek once
          // while paused, then capture the decoded frame instead of caching black.
          if (
            onFrameReady &&
            capturedSource.current !== src &&
            posterSeek.current !== src &&
            event.currentTarget.paused
          ) {
            posterSeek.current = src
            event.currentTarget.currentTime = Number.isFinite(event.currentTarget.duration)
              ? Math.min(0.1, event.currentTarget.duration / 2)
              : 0.1
          }
        }}
        onSeeked={(event) => {
          if (posterSeek.current === src) {
            posterSeek.current = null
            capturedSource.current = src
            onFrameReady?.(event.currentTarget)
          }
        }}
        onWaiting={(event) => setWaiting(!event.currentTarget.paused)}
        onPlay={(event) => {
          setPlayingSource(src)
          setWaiting(event.currentTarget.readyState < HTMLMediaElement.HAVE_FUTURE_DATA)
        }}
        onPlaying={() => {
          if (onFrameReady && capturedSource.current !== src && media.current) {
            capturedSource.current = src
            posterSeek.current = null
            onFrameReady(media.current)
          }
          setPlayingSource(src)
          setReady(src)
          setFailure(null)
          setWaiting(false)
        }}
        onCanPlay={() => {
          setReady(src)
          setFailure(null)
          setWaiting(false)
        }}
        onPause={() => {
          setPlayingSource(null)
          setWaiting(false)
        }}
        onEnded={() => {
          setPlayingSource(null)
          setWaiting(false)
        }}
        onTimeUpdate={(event) => {
          if (event.currentTarget.getAttribute('src') === src && event.currentTarget.readyState > 0)
            position.current = { src, time: event.currentTarget.currentTime }
        }}
        onLoadedMetadata={(event) => {
          const video = event.currentTarget
          // metadata 预读允许停在 HAVE_METADATA；闲置时无需等到整段可播放。
          setReady(src)
          setFailure(null)
          setWaiting(!video.paused && video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA)
          if (video.videoWidth > 0 && video.videoHeight > 0) {
            const ratio = `${video.videoWidth} / ${video.videoHeight}`
            setDimensions({ src, ratio })
            onAspectRatioChange?.(ratio)
          }
          if (position.current.src === src && position.current.time > 0)
            event.currentTarget.currentTime = Math.min(
              position.current.time,
              event.currentTarget.duration,
            )
        }}
      />
      {loading && (
        <span role="status" aria-label={loadingLabel} className="sr-only">
          {loadingLabel}
        </span>
      )}
      {failure === src && (
        <div
          role="alert"
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-card p-4 text-center text-sm text-foreground"
        >
          <p>{errorLabel}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setFailure(null)
              setReady(null)
              setWaiting(false)
              setAttempt((value) => value + 1)
            }}
          >
            <Icon name="refresh" className="mr-1.5" />
            {retryLabel}
          </Button>
        </div>
      )}
    </div>
  )
}
