import { type ImgHTMLAttributes, useEffect, useState } from 'react'
import { mediaIdentity, resolveMediaSource } from '../../../lib/cloudMedia'

export function useNodeMedia(source: string | undefined): string | undefined {
  const [resolved, setResolved] = useState<{ source: string; value: string }>()
  useEffect(() => {
    if (!source || !mediaIdentity(source)) return
    let alive = true
    void resolveMediaSource(source, 'preview').then(
      (value) => {
        if (alive) setResolved({ source, value })
      },
      () => {},
    )
    return () => {
      alive = false
    }
  }, [source])
  return source && mediaIdentity(source)
    ? resolved?.source === source
      ? resolved.value
      : undefined
    : source
}

export default function NodeMediaImage({
  src,
  alt = '',
  ...props
}: ImgHTMLAttributes<HTMLImageElement>) {
  const source = useNodeMedia(src)
  return <img {...props} src={source} alt={alt} />
}
