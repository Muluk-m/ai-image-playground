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

/**
 * 结论按图片 id 记，连同判它时的那串 data URL：串不同（同一 id 换了内容）就当没判过，重判。
 * 只留最近 32 条，移走的图留得不多。
 */
const verdicts = new Map<string, { dataUrl: string; code: UnusableReferenceCode | null }>()
const checking = new Map<string, string>()
const listeners = new Set<() => void>()
const MAX_VERDICTS = 32
// 浏览器迟迟不回解码结果时不一直拦着：到点按能用放行，坏图由服务端兜底（失败退还预扣）。
const DECODE_TIMEOUT_MS = 15_000

const verdictFor = (image: ReferenceImage) => {
  const entry = verdicts.get(image.id)
  return entry && entry.dataUrl === image.dataUrl ? entry : undefined
}
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
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, DECODE_TIMEOUT_MS)
  })
  try {
    await Promise.race([loadImage(image.dataUrl), timeout])
    return null
  } catch {
    return knownHeader(image.dataUrl) ? 'media_invalid_image' : 'media_unsupported_image'
  } finally {
    clearTimeout(timer)
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
      if (!isLocal(image) || verdictFor(image) || checking.get(image.id) === image.dataUrl) continue
      const { id, dataUrl } = image
      checking.set(id, dataUrl)
      void inspect(image).then((code) => {
        // 判的期间这张图又换了内容，就丢掉这次结论，等新那次。
        if (checking.get(id) !== dataUrl) return
        checking.delete(id)
        verdicts.delete(id)
        if (verdicts.size >= MAX_VERDICTS) verdicts.delete(verdicts.keys().next().value!)
        verdicts.set(id, { dataUrl, code })
        for (const listener of listeners) listener()
      })
    }
  }, [images])
  const failures = new Map<number, UnusableReferenceCode>()
  let pending = 0
  images.forEach((image, index) => {
    if (!isLocal(image)) return
    const verdict = verdictFor(image)
    if (!verdict) pending += 1
    else if (verdict.code) failures.set(index, verdict.code)
  })
  return { failures, pending }
}
