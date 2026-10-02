import { bffBaseUrl } from '../../../lib/runtimeConfig'
import type { LookItem } from '../lib/looks'
import AssetThumb from './AssetThumb'

type Source = LookItem['references'][number]

/** 预置模板的图在 BFF 上（相对路径），自建的在本机 image store 里；这里把两种画成一样。 */
export default function LookImage({
  source,
  alt,
  className,
}: {
  source: Source | null
  alt: string
  className?: string
}) {
  const fill = className ?? 'h-full w-full object-cover'
  if (!source) return <div className={`${fill} bg-muted`} aria-hidden="true" />
  // 只有调用方显式给了尺寸约束才往下传；卡片缩略图沿用 AssetThumb 自带的悬停放大。
  if (source.kind === 'image')
    return <AssetThumb imageId={source.imageId} alt={alt} className={className} />
  return <img src={lookImageUrl(source.url)} alt={alt} className={fill} loading="lazy" />
}

export function lookImageUrl(path: string): string {
  return /^https?:\/\//.test(path) ? path : `${bffBaseUrl()}${path}`
}
