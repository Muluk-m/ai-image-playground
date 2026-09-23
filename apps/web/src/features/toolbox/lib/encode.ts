import { canvasToBlob } from '../../../lib/canvasImage'
import { extensionFor } from './naming'

export type OutputFormat = 'keep' | 'image/jpeg' | 'image/png' | 'image/webp' | 'image/avif'

/**
 * canvas 原生能编的只有这三种（Safari 连 WebP 都不能编，AVIF 全平台都不能）。
 * 规范规定不支持的 type **静默**回退成 PNG，`try/catch` 抓不到——所以编完必须看 `blob.type`。
 * wasm 编码器（`@jsquash`）由 #807 接上，接上之后这张表只影响「保持原格式」的落点。
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

export async function encodeCanvas(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<EncodedImage> {
  const blob = await canvasToBlob(canvas, type, quality)
  // 老浏览器偶尔给回空 type；那种情况按请求的算，别在卡片上凭空标一个回退。
  const actual = blob.type || type
  return { blob, type: actual, fellBack: actual !== type }
}
