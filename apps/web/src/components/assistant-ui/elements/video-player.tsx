import { useState } from 'react'
import { Button } from '../../ui/button'

/** Native media controls keep playback keyboard accessible and avoid automatic playback. */
export function VideoPlayer({
  src,
  poster,
  label,
  errorLabel,
  retryLabel,
  aspectRatio = '16 / 9',
}: {
  src: string
  poster?: string
  label: string
  errorLabel: string
  retryLabel: string
  aspectRatio?: string
}) {
  const [failure, setFailure] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  return (
    <div
      data-slot="video-player"
      className="relative max-h-[65vh] overflow-hidden rounded-xl bg-black"
      style={{ aspectRatio }}
    >
      <video
        key={`${src}:${attempt}`}
        src={src}
        poster={poster}
        controls
        playsInline
        preload="none"
        aria-label={label}
        className="h-full max-h-[65vh] w-full object-contain"
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
