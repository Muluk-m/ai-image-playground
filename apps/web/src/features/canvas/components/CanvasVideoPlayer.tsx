import { useEffect, useRef } from 'react'

/** 画布上就地播放一段视频：旧画布的播放浮层与节点画布的视频节点共用。 */
export default function CanvasVideoPlayer({
  src,
  poster,
  onEnded,
}: {
  src: string
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
      src={src}
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
