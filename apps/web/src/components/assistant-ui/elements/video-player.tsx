import { LoaderCircle, RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '../../ui/button'

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
  aspectRatio = '16 / 9',
  fill = false,
  maxHeight,
}: {
  src: string
  poster?: string
  label: string
  errorLabel: string
  retryLabel: string
  loadingLabel: string
  onFrameReady?: (video: HTMLVideoElement) => void
  aspectRatio?: string
  fill?: boolean
  maxHeight?: string
}) {
  const frame = useRef<HTMLDivElement>(null)
  const media = useRef<HTMLVideoElement>(null)
  const [nearViewport, setNearViewport] = useState(false)
  const [playingSource, setPlayingSource] = useState<string | null>(null)
  const position = useRef({ src, time: 0 })
  const loadMedia = nearViewport || playingSource === src
  const [failure, setFailure] = useState<string | null>(null)
  const [ready, setReady] = useState<string | null>(null)
  const [waiting, setWaiting] = useState(false)
  const [attempt, setAttempt] = useState(0)
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
      { rootMargin: '160px' },
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
      style={fill ? { aspectRatio, maxHeight } : playerFrameStyle(aspectRatio)}
    >
      <video
        ref={media}
        key={`${src}:${attempt}`}
        src={loadMedia ? src : undefined}
        poster={poster}
        controls
        playsInline
        crossOrigin="use-credentials"
        preload={nearViewport ? 'auto' : 'none'}
        aria-label={label}
        className="absolute inset-0 h-full w-full bg-black object-contain"
        onError={() => {
          setFailure(src)
          setWaiting(false)
        }}
        onLoadedData={(event) => {
          setFailure(null)
          setReady(src)
          if (event.currentTarget.currentTime === 0) onFrameReady?.(event.currentTarget)
        }}
        onWaiting={() => setWaiting(true)}
        onPlay={() => setPlayingSource(src)}
        onPlaying={() => {
          setPlayingSource(src)
          setWaiting(false)
        }}
        onCanPlay={() => setWaiting(false)}
        onPause={() => {
          setPlayingSource(null)
          setWaiting(false)
        }}
        onEnded={() => setPlayingSource(null)}
        onTimeUpdate={(event) => {
          if (event.currentTarget.getAttribute('src') === src && event.currentTarget.readyState > 0)
            position.current = { src, time: event.currentTarget.currentTime }
        }}
        onLoadedMetadata={(event) => {
          if (position.current.src === src && position.current.time > 0)
            event.currentTarget.currentTime = Math.min(
              position.current.time,
              event.currentTarget.duration,
            )
        }}
      />
      {nearViewport && failure !== src && (ready !== src || waiting) && (
        <div
          role="status"
          aria-label={loadingLabel}
          className="pointer-events-none absolute inset-0 grid place-items-center"
        >
          <span className="grid size-10 place-items-center rounded-full bg-black/50 text-white">
            <LoaderCircle
              className="size-5 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          </span>
        </div>
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
            <RotateCcw className="mr-1.5 size-4" aria-hidden="true" />
            {retryLabel}
          </Button>
        </div>
      )}
    </div>
  )
}
