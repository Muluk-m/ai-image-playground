import { bffBaseUrl } from '../../../lib/runtimeConfig'
import type { LookItem } from '../lib/looks'
import AssetThumb from './AssetThumb'

type Source = LookItem['references'][number]

/** 预置模板的图在 BFF 上（相对路径），自建的在本机 image store 里；这里把两种画成一样。 */
export default function LookImage({
  source,
  alt,
  className = 'h-full w-full object-cover',
}: {
  source: Source | null
  alt: string
  className?: string
}) {
  if (!source) return <div className={`${className} bg-muted`} aria-hidden="true" />
  if (source.kind === 'image') return <AssetThumb imageId={source.imageId} alt={alt} />
  return <img src={lookImageUrl(source.url)} alt={alt} className={className} loading="lazy" />
}

export function lookImageUrl(path: string): string {
  return /^https?:\/\//.test(path) ? path : `${bffBaseUrl()}${path}`
}
