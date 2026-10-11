import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from '../../../i18n'
import PlayBadge from '../../video/components/PlayBadge'
import type { CanvasEditor } from '../lib/editor'
import { recoverVideoPoster } from '../lib/recoverVideoPoster'
import { type CanvasVideo, canvasVideos } from '../lib/videoElements'

/**
 * 视频对象的播放浮层：封面由画布本体画（image 元素），播放器走 DOM 浮层。
 * 只有播放键与播放器本身收指针，其余穿透——整块收指针会让画布上的视频选不中、拖不动。
 */
export default function CanvasVideoOverlay({
  editor,
  active = true,
}: {
  editor: CanvasEditor
  active?: boolean
}) {
  const { t } = useTranslation('canvas')
  useSyncExternalStore(editor.doc.subscribe, () => editor.doc.version)
  const overlays = useRef<HTMLDivElement>(null)
  const [playingId, setPlayingId] = useState<string | null>(null)
  const { camera } = editor.doc
  const videos = canvasVideos(editor)

  const videoIds = videos
    .map((video) => {
      const el = editor.getElement(video.id)
      return `${video.id}:${el?.type === 'image' ? el.fileId : ''}`
    })
    .join('|')
  useEffect(() => {
    if (!active || !overlays.current) return
    const nodes = overlays.current.querySelectorAll<HTMLElement>('[data-video-object]')
    const recover = (node: HTMLElement) => {
      const id = node.dataset.videoObject
      if (id) void recoverVideoPoster(editor, id)
    }
    if (typeof IntersectionObserver === 'undefined') {
      for (const node of nodes) if (node.getClientRects().length) recover(node)
      return
    }
    let current = true
    const observer = new IntersectionObserver(
      (entries) => {
        if (!current) return
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          recover(entry.target as HTMLElement)
          observer.unobserve(entry.target)
        }
      },
      { root: overlays.current },
    )
    for (const node of nodes) observer.observe(node)
    return () => {
      current = false
      observer.disconnect()
    }
  }, [editor, videoIds, active])

  if (videos.length === 0) return null

  return (
    <div ref={overlays} className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
      {videos.map((video) => (
        <div
          key={video.id}
          data-video-object={video.id}
          className="absolute grid place-items-center"
          style={{
            left: (video.x - camera.x) * camera.zoom,
            top: (video.y - camera.y) * camera.zoom,
            width: video.width,
            height: video.height,
            transform: `scale(${camera.zoom}) rotate(${video.rotation}deg)`,
            transformOrigin: 'top left',
          }}
        >
          {playingId === video.id ? (
            <Player
              poster={(() => {
                const el = editor.getElement(video.id)
                return el?.type === 'image' ? editor.doc.files[el.fileId] : undefined
              })()}
              video={video}
              onEnded={() => setPlayingId(null)}
            />
          ) : (
            <button
              type="button"
              aria-label={t('videoOverlay.play')}
              className="pointer-events-auto"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => setPlayingId(video.id)}
            >
              <PlayBadge />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

function Player({
  video,
  poster,
  onEnded,
}: {
  video: CanvasVideo
  poster?: string
  onEnded: () => void
}) {
  const element = useRef<HTMLVideoElement>(null)

  // 摘下来的 <video> 在被回收前还在拉流、还在响；React 不替你停。
  useEffect(
    () => () => {
      const node = element.current
      if (!node) return
      node.pause()
      node.removeAttribute('src')
      node.load()
    },
    [],
  )

  return (
    <video
      ref={element}
      src={video.url}
      poster={poster}
      playsInline
      crossOrigin="use-credentials"
      className="pointer-events-auto h-full w-full bg-black object-contain"
      controls
      autoPlay
      onPointerDown={(event) => event.stopPropagation()}
      onEnded={onEnded}
    >
      <track kind="captions" />
    </video>
  )
}
