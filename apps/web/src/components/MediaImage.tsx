import { type ImgHTMLAttributes, useEffect, useState } from 'react'
import { scopedStorageName } from '../lib/authScope'
import { mediaIdentity, resolveMediaSource } from '../lib/cloudMedia'

/** Render a local image or an authenticated cloud preview without persisting its signed URL. */
export default function MediaImage({ src, ...props }: ImgHTMLAttributes<HTMLImageElement>) {
  const scope = scopedStorageName('media')
  const [resolved, setResolved] = useState<{ source: string; value: string; scope: string }>()
  useEffect(() => {
    let current = true
    if (src && mediaIdentity(src))
      void resolveMediaSource(src, 'preview').then(
        (value) => {
          if (current) setResolved({ source: src, value, scope })
        },
        () => {},
      )
    return () => {
      current = false
    }
  }, [src, scope])
  const value =
    src && mediaIdentity(src)
      ? resolved?.source === src && resolved.scope === scope
        ? resolved.value
        : undefined
      : src
  return <img {...props} src={value} />
}
