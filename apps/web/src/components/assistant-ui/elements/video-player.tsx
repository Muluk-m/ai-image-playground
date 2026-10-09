import { useState } from 'react'
import { Button } from '../../ui/button'

/**
 * 长边停在 24rem，矮窗口再收到 46vh。65vh 的竖屏会占满整栏。
 * 播放器在纵向 flex 里会被撑满栏宽，只写 aspect-ratio 和 max-height 时高度被截断、
 * 宽度不收回，9:16 就变成一块横着的空舞台。这里改限制宽度，高度由比例自己算。
 */
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

/** Native media controls keep playback keyboard accessible and avoid automatic playback. */
export function VideoPlayer({
  src,
  poster,
  label,
  errorLabel,
  retryLabel,
  aspectRatio = '16 / 9',
  fill = false,
  maxHeight,
}: {
  src: string
  poster?: string
  label: string
  errorLabel: string
  retryLabel: string
  aspectRatio?: string
  /** 由外层定宽（贴合卡片）时铺满宽度、不再自带圆角和高度上限。 */
  fill?: boolean
  maxHeight?: string
}) {
  const [failure, setFailure] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  return (
    <div
      data-slot="video-player"
      className={
        fill
          ? 'relative w-full overflow-hidden bg-black'
          : 'relative max-w-full self-start overflow-hidden rounded-xl bg-black'
      }
      style={fill ? { aspectRatio, maxHeight } : playerFrameStyle(aspectRatio)}
    >
      <video
        key={`${src}:${attempt}`}
        src={src}
        poster={poster}
        controls
        playsInline
        preload="none"
        aria-label={label}
        className="absolute inset-0 h-full w-full bg-black object-contain"
        onError={() => setFailure(src)}
        onLoadedData={() => setFailure(null)}
      />
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
              setAttempt((value) => value + 1)
            }}
          >
            {retryLabel}
          </Button>
        </div>
      )}
    </div>
  )
}
