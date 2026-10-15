import { useEffect, useRef } from 'react'

/** 画布上就地播放一段视频：旧画布的播放浮层与节点画布的视频节点共用。 */
export default function CanvasVideoPlayer({
  src,
  poster,
  onEnded,
  onTimeChange,
}: {
  src: string
  poster?: string
  onEnded: () => void
  onTimeChange?: (seconds: number) => void
}) {
  const element = useRef<HTMLVideoElement>(null)

  // 摘下来的 <video> 在被回收前还在拉流、还在响；React 不替你停。
  // 卸载时 ref 先于清理函数被置空，所以在挂载时就把元素记下来；
  // StrictMode 会先清理再重挂同一个元素，重挂时把被摘掉的来源补回去。
  useEffect(() => {
    const node = element.current
    if (node && !node.getAttribute('src')) {
      node.setAttribute('src', src)
      node.load()
    }
    return () => {
      if (!node) return
      node.pause()
      node.removeAttribute('src')
      node.load()
    }
  }, [src])

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
      onTimeUpdate={(event) => onTimeChange?.(event.currentTarget.currentTime)}
    >
      <track kind="captions" />
    </video>
  )
}
