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
  /** 浏览器编不出所选格式，给了别的。 */
  fellBack: boolean
}

/**
 * 编码一张画布。先让 canvas 原生编（快、不下载任何东西）；拿回来的格式不对——Safari 的 WebP、
 * 全平台的 AVIF——就交给 wasm 编码器，真实格式与所选一致。wasm 也失败时才照实标「已回退」。
 */
export async function encodeCanvas(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<EncodedImage> {
  const blob = await canvasToBlob(canvas, type, quality)
  // 老浏览器偶尔给回空 type；那种情况按请求的算，别在卡片上凭空标一个回退。
  const actual = blob.type || type
  if (actual === type) return { blob, type, fellBack: false }
  if (type === 'image/webp' || type === 'image/avif') {
    try {
      return { blob: await encodeWithWasm(canvas, type, quality ?? 0.8), type, fellBack: false }
    } catch {
      // 编码器没下载下来：给用户 canvas 那一份，并照实标出来。
    }
  }
  return { blob, type: actual, fellBack: true }
}
