import { useEffect, useState } from 'react'
import { loadImage } from './canvasImage'
import { imageMimeFromBytes } from './imageBytes'

/**
 * 快速生成的参考图不在选图时上传，也就没有上传那一步的坏图判定（BUG-59）。这里在本机判：
 * 每张本地图都让浏览器解一次，解得出就能用（GIF、AVIF 之类发送前会转码）；解不出的，
 * 文件头认不出报 `media_unsupported_image`，文件头是 PNG / JPEG / WebP 却解不出（截断、
 * 损坏）报 `media_invalid_image`，与智能创作上传时同一套错误码。
 */
export type UnusableReferenceCode = 'media_unsupported_image' | 'media_invalid_image'
export type ReferenceImage = { id: string; dataUrl: string }

/** 结论按「图片 id + 长度 + 末尾一小段」记，不拿整串 data URL 当键，移走的图不会被这里留住。 */
const verdicts = new Map<string, UnusableReferenceCode | null>()
const checking = new Set<string>()
const listeners = new Set<() => void>()
const MAX_VERDICTS = 200

const verdictKey = (image: ReferenceImage) =>
  `${image.id}:${image.dataUrl.length}:${image.dataUrl.slice(-32)}`
// 云媒体按身份发，字节在服务端，由服务端核。
const isLocal = (image: ReferenceImage) => image.dataUrl.startsWith('data:')

function knownHeader(dataUrl: string): boolean {
  const comma = dataUrl.indexOf(',')
  if (comma < 0 || !dataUrl.slice(0, comma).endsWith(';base64')) return false
  try {
    const head = atob(dataUrl.slice(comma + 1, comma + 25))
    return Boolean(imageMimeFromBytes(Uint8Array.from(head, (c) => c.charCodeAt(0)).buffer))
  } catch {
    return false
  }
}

async function inspect(image: ReferenceImage): Promise<UnusableReferenceCode | null> {
  try {
    await loadImage(image.dataUrl)
    return null
  } catch {
    return knownHeader(image.dataUrl) ? 'media_invalid_image' : 'media_unsupported_image'
  }
}

/**
 * 这几张里用不了的（序号从 0 起，附错误码），以及还在解的张数。
 * 还在解的由调用方先拦着发送，解完再刷新一次。
 */
export function useUnusableReferences(images: readonly ReferenceImage[]): {
  failures: Map<number, UnusableReferenceCode>
  pending: number
} {
  const [, settled] = useState(0)
  useEffect(() => {
    const listener = () => settled((n) => n + 1)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])
  useEffect(() => {
    for (const image of images) {
      const key = verdictKey(image)
      if (!isLocal(image) || verdicts.has(key) || checking.has(key)) continue
      checking.add(key)
      void inspect(image).then((code) => {
        checking.delete(key)
        if (verdicts.size >= MAX_VERDICTS) verdicts.delete(verdicts.keys().next().value!)
        verdicts.set(key, code)
        for (const listener of listeners) listener()
      })
    }
  }, [images])
  const failures = new Map<number, UnusableReferenceCode>()
  let pending = 0
  images.forEach((image, index) => {
    if (!isLocal(image)) return
    const key = verdictKey(image)
    if (!verdicts.has(key)) pending += 1
    else {
      const code = verdicts.get(key)
      if (code) failures.set(index, code)
    }
  })
  return { failures, pending }
}
