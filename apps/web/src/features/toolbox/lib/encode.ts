import { canvasToBlob } from '../../../lib/canvasImage'
import { extensionFor } from './naming'
import { encodeWithWasm } from './wasmEncoder'

export type OutputFormat = 'keep' | 'image/jpeg' | 'image/png' | 'image/webp' | 'image/avif'

/**
 * canvas 原生能编的只有这三种（Safari 连 WebP 都不能编，AVIF 全平台都不能）。
 * 规范规定不支持的 type **静默**回退成 PNG，`try/catch` 抓不到——所以编完必须看 `blob.type`。
 * 编不出来的交给 wasm（见 `encodeCanvas`）；这张表只决定「保持原格式」的落点。
 */
const CANVAS_ENCODABLE: Record<string, true> = {
  'image/jpeg': true,
  'image/png': true,
  'image/webp': true,
}

/** 格式在界面上的写法：是数据不是文案，中英文都长这样。 */
const FORMAT_LABELS: Record<string, string> = {
  'image/jpeg': 'JPG',
  'image/png': 'PNG',
  'image/webp': 'WebP',
  'image/avif': 'AVIF',
}

export function formatLabel(type: string): string {
  return FORMAT_LABELS[type] ?? extensionFor(type).toUpperCase()
}

/** 「保持原格式」落到哪个 MIME：源格式编不出来（HEIC、GIF…）时退到 PNG，不丢像素。 */
export function resolveOutputType(format: OutputFormat, sourceType: string): string {
  if (format !== 'keep') return format
  return CANVAS_ENCODABLE[sourceType] ? sourceType : 'image/png'
}

export interface EncodedImage {
  blob: Blob
  /** 真实出来的格式，不是请求的那个。 */
  type: string
  /** 兼容性角标用；选择的格式编不出时本模块会报错，不返回错误格式。 */
  fellBack: boolean
}

/**
 * 先用浏览器编码；Safari 的 WebP、全平台的 AVIF 由按需加载的 wasm 补齐。
 * 两个编码器都失败时必须报错，不能把 PNG 伪装成所选格式交给用户。
 */
export async function encodeCanvas(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<EncodedImage> {
  const blob = await canvasToBlob(canvas, type, quality)
  const actual = blob.type
  if (actual === type) return { blob, type, fellBack: false }
  if (type === 'image/webp' || type === 'image/avif') {
    return { blob: await encodeWithWasm(canvas, type, quality ?? 0.8), type, fellBack: false }
  }
  throw new Error(`Unsupported image encoder: ${type}`)
}
