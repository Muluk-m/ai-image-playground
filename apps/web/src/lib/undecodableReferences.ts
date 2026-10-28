import { useEffect, useState } from 'react'
import { loadImage } from './canvasImage'
import { imageMimeFromBytes } from './imageBytes'

/**
 * 快速生成的参考图不在选图时上传，也就没有上传那一步的坏图判定（BUG-59）。这里在本机判：
 * 文件头是 PNG / JPEG / WebP 的算能用；认不出的再让浏览器解一次（GIF、AVIF 之类发送前会转码），
 * 解不出就是坏图，与智能创作上传时报的 `media_unsupported_image` 同一个结论。
 */
const verdicts = new Map<string, boolean>()
const checking = new Set<string>()
/** 只记认不出文件头的那几张，量很小；留个上限，免得一直换图时攒着整串 data URL。 */
const MAX_VERDICTS = 50

function knownHeader(source: string): boolean {
  // 云媒体按身份发，字节在服务端，由服务端核。
  if (!source.startsWith('data:')) return true
  const comma = source.indexOf(',')
  if (comma < 0 || !source.slice(0, comma).endsWith(';base64')) return false
  let head: string
  try {
    head = atob(source.slice(comma + 1, comma + 25))
  } catch {
    return false
  }
  return Boolean(imageMimeFromBytes(Uint8Array.from(head, (c) => c.charCodeAt(0)).buffer))
}

function remember(source: string, decodable: boolean) {
  if (verdicts.size >= MAX_VERDICTS) verdicts.delete(verdicts.keys().next().value!)
  verdicts.set(source, decodable)
}

const listeners = new Set<() => void>()

/** 这几张里浏览器解不出来的序号（从 0 起）。还在解的不算，解完再刷新一次。 */
export function useUndecodableReferences(sources: readonly string[]): number[] {
  const [, settled] = useState(0)
  useEffect(() => {
    const listener = () => settled((n) => n + 1)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])
  useEffect(() => {
    for (const source of sources) {
      if (verdicts.has(source) || checking.has(source) || knownHeader(source)) continue
      checking.add(source)
      void loadImage(source)
        .then(
          () => true,
          () => false,
        )
        .then((decodable) => {
          checking.delete(source)
          remember(source, decodable)
          for (const listener of listeners) listener()
        })
    }
  }, [sources])
  return sources.flatMap((source, index) => (verdicts.get(source) === false ? [index] : []))
}
