import { useState, useSyncExternalStore } from 'react'
import PlayBadge from '../../video/components/PlayBadge'
import type { CanvasEditor } from '../lib/editor'
import { type CanvasVideo, canvasVideos } from '../lib/videoElements'

/**
 * 视频对象的播放浮层：封面由画布本体画（image 元素），播放器走 DOM 浮层。
 * 容器保持指针穿透，只有播放入口与播放器本身收指针，滚轮缩放与拖拽平移照旧。
 */
export default function CanvasVideoOverlay({ editor }: { editor: CanvasEditor }) {
  useSyncExternalStore(editor.doc.subscribe, () => editor.doc.version)
  const [playingId, setPlayingId] = useState<string | null>(null)
  const { camera } = editor.doc
  const videos = canvasVideos(editor)

  if (videos.length === 0) return null

  return (
    <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
      {videos.map((video) => (
        <div
          key={video.id}
          className="absolute"
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
            <Player video={video} onEnded={() => setPlayingId(null)} />
          ) : (
            <button
              type="button"
              aria-label="播放"
              className="pointer-events-auto grid h-full w-full place-items-center"
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

function Player({ video, onEnded }: { video: CanvasVideo; onEnded: () => void }) {
  return (
    <video
      src={video.url}
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
