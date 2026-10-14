import { type ImgHTMLAttributes, useEffect, useState } from 'react'
import { mediaIdentity, resolveMediaSource } from '../../../lib/cloudMedia'

export function useNodeMedia(source: string | undefined): string | undefined {
  const [resolved, setResolved] = useState<{ source: string; value: string }>()
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
          if (alive && attempts++ < 3) timer = setTimeout(load, 1000 * 2 ** (attempts - 1))
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
