import { type ImgHTMLAttributes, useEffect, useRef, useState } from 'react'
import { mediaIdentity, resolveMediaSource } from '../../../lib/cloudMedia'

export type NodeMediaState =
  | { status: 'ready'; url: string }
  | { status: 'loading' }
  | { status: 'missing' }

/** 本机地址直接可用。云媒体要等预览下来：重试还没耗尽是加载中，耗尽才是缺失。 */
export function useNodeMedia(source: string | undefined): NodeMediaState {
  const [resolved, setResolved] = useState<{ source: string; value: string }>()
  const [failed, setFailed] = useState<string>()
  useEffect(() => {
    if (!source || !mediaIdentity(source)) return
    let alive = true
    let attempts = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = () => {
      clearTimeout(timer)
      void resolveMediaSource(source, 'preview').then(
        (value) => {
          if (alive) setResolved({ source, value })
        },
        () => {
          if (!alive) return
          if (attempts++ < 3) timer = setTimeout(load, 1000 * 2 ** (attempts - 1))
          else setFailed(source)
        },
      )
    }
    const online = () => {
      attempts = 0
      load()
    }
    window.addEventListener('online', online)
    load()
    return () => {
      alive = false
      clearTimeout(timer)
      window.removeEventListener('online', online)
    }
  }, [source])
  if (!source) return { status: 'missing' }
  if (!mediaIdentity(source)) return { status: 'ready', url: source }
  if (resolved?.source === source) return { status: 'ready', url: resolved.value }
  if (failed === source) return { status: 'missing' }
  return { status: 'loading' }
}

export default function NodeMediaImage({
  src,
  alt = '',
  ...props
}: ImgHTMLAttributes<HTMLImageElement>) {
  const media = useNodeMedia(src)
  return <img {...props} src={media.status === 'ready' ? media.url : undefined} alt={alt} />
}

/**
 * 节点上的那张图。云地址还在下载时，同一张图沿用上一帧；换成另一张且没有上一帧就留空骨架。
 * 只有确认缺失，或别的设备还在上传，才写说明。
 */
export function NodePicture({
  source,
  identity,
  uploading,
  rotation,
  missingLabel,
  uploadingLabel,
}: {
  source: string | undefined
  /** 同一张像素的身份。云同步只换存储地址，不换这个值。 */
  identity: string | undefined
  uploading: boolean
  rotation?: number
  missingLabel: string
  uploadingLabel: string
}) {
  const media = useNodeMedia(source)
  const held = useRef<{ identity: string; url: string } | undefined>(undefined)
  if (media.status === 'ready' && identity) held.current = { identity, url: media.url }
  const carried =
    media.status === 'loading' && identity && held.current?.identity === identity
      ? held.current.url
      : undefined
  const url = media.status === 'ready' ? media.url : carried
  const frame = rotation
    ? { transform: `rotate(${rotation}deg)`, transformOrigin: '0 0' }
    : undefined
  if (url)
    return (
      <img
        src={url}
        alt=""
        draggable={false}
        className="studio-node-media"
        data-testid="node-media-image"
        style={frame}
      />
    )
  if (media.status === 'loading')
    return (
      <div
        className="studio-node-media animate-pulse bg-muted motion-reduce:animate-none"
        data-testid="node-media-loading"
        aria-busy="true"
        style={frame}
      />
    )
  return (
    <div className="studio-node-missing text-sm" data-testid="node-media-missing">
      {uploading ? uploadingLabel : missingLabel}
    </div>
  )
}
