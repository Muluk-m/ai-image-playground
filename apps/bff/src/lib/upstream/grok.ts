import { Buffer } from 'node:buffer'
import sharp from 'sharp'
import type { HydratedSubmitRequest } from '../imageArchive'
import { buildOpenAIBody, decodeDataUrl } from './openai'
import { clientError } from './shared'

const GROK_IMAGINE_2_MODEL_ID = 'grok-imagine-image-2.0'

const GROK_IMAGINE_2_MAX_INPUTS = 5

export function isGrokImagine2(model: string): boolean {
  return model === GROK_IMAGINE_2_MODEL_ID
}

/** xAI 2.0 官方比例。OpenAI WxH 归到最近的一档。 */
const GROK_ASPECT_RATIOS: ReadonlyArray<{ label: string; value: number }> = [
  { label: '1:1', value: 1 },
  { label: '16:9', value: 16 / 9 },
  { label: '9:16', value: 9 / 16 },
  { label: '4:3', value: 4 / 3 },
  { label: '3:4', value: 3 / 4 },
  { label: '3:2', value: 3 / 2 },
  { label: '2:3', value: 2 / 3 },
  { label: '2:1', value: 2 },
  { label: '1:2', value: 1 / 2 },
  { label: '19.5:9', value: 19.5 / 9 },
  { label: '9:19.5', value: 9 / 19.5 },
  { label: '20:9', value: 20 / 9 },
  { label: '9:20', value: 9 / 20 },
  { label: '21:9', value: 21 / 9 },
  { label: '5:2', value: 5 / 2 },
]

/** 前端比例选择器落盘的 1K 预设 → 精确比例，避免 1280x544 被算成 5:2。 */
const GROK_SIZE_TO_ASPECT: Readonly<Record<string, string>> = {
  '1024x1024': '1:1',
  '1536x1024': '3:2',
  '1024x1536': '2:3',
  '1280x720': '16:9',
  '720x1280': '9:16',
  '1024x768': '4:3',
  '768x1024': '3:4',
  '1280x544': '21:9',
}

function grokAspectRatioFromSize(size: string | undefined): string | undefined {
  if (!size) return undefined
  const trimmed = size.trim()
  if (!trimmed || trimmed.toLowerCase() === 'auto') return undefined
  if (GROK_ASPECT_RATIOS.some((ratio) => ratio.label === trimmed)) return trimmed
  const normalized = trimmed.toLowerCase().replace(/×/g, 'x').replace(/\s+/g, '')
  const exact = GROK_SIZE_TO_ASPECT[normalized]
  if (exact) return exact
  const match = trimmed.match(/^(\d+)\s*[xX×]\s*(\d+)$/)
  if (!match) return undefined
  const width = Number(match[1])
  const height = Number(match[2])
  if (!width || !height) return undefined
  const ratio = width / height
  let best = GROK_ASPECT_RATIOS[0]!
  let bestDelta = Number.POSITIVE_INFINITY
  for (const candidate of GROK_ASPECT_RATIOS) {
    const delta = Math.abs(Math.log(ratio) - Math.log(candidate.value))
    if (delta < bestDelta) {
      best = candidate
      bestDelta = delta
    }
  }
  return best.label
}

/** xAI 2.0 没有 high：high 落到 medium + 2k。 */
function grok2QualityFromOpenAI(quality: string | undefined): {
  quality?: 'low' | 'medium'
  resolution?: '1k' | '2k'
} {
  if (!quality || quality === 'auto') return {}
  if (quality === 'low') return { quality: 'low', resolution: '1k' }
  if (quality === 'medium') return { quality: 'medium', resolution: '1k' }
  if (quality === 'high') return { quality: 'medium', resolution: '2k' }
  return {}
}

const GROK2_STRIPPED_EXTRA_KEYS = new Set([
  'n',
  'size',
  'quality',
  'output_format',
  'output_compression',
  'moderation',
  'aspect_ratio',
  'resolution',
])

export function buildGrokImagine2Body(
  model: string,
  request: HydratedSubmitRequest,
): Record<string, unknown> {
  const extra: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(request.extra ?? {})) {
    if (GROK2_STRIPPED_EXTRA_KEYS.has(key) || value == null) continue
    extra[key] = value
  }
  const aspectRatio = grokAspectRatioFromSize(request.size)
  const mapped = grok2QualityFromOpenAI(request.quality)
  return {
    model,
    prompt: request.prompt,
    ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
    ...(mapped.quality ? { quality: mapped.quality } : {}),
    ...(mapped.resolution ? { resolution: mapped.resolution } : {}),
    ...extra,
  }
}

export function buildGrokEditBody(
  model: string,
  request: HydratedSubmitRequest,
): Record<string, unknown> {
  // n 由上层 fan-out 承担；extra 最后 spread 进 body，所以 extra.n 也要一起剥。
  const grok2 = isGrokImagine2(model)
  const { n: _n, ...body } = grok2
    ? buildGrokImagine2Body(model, request)
    : buildOpenAIBody(model, request)
  const images = (request.input_images ?? []).map((url) => ({ type: 'image_url' as const, url }))
  if (grok2 && images.length > 1) return { ...body, images }
  const image = images[0]
  return {
    ...body,
    ...(image ? { image } : {}),
    ...(!grok2 && request.mask ? { mask: { type: 'image_url', url: request.mask } } : {}),
  }
}

function grokClientError(message: string): never {
  throw clientError(message)
}

export function normalizeGrokImagine2EditInputs(
  request: HydratedSubmitRequest,
): HydratedSubmitRequest {
  const inputImages = request.input_images ?? []
  if (inputImages.length > GROK_IMAGINE_2_MAX_INPUTS) {
    grokClientError(
      `Grok Imagine 2.0 最多支持 ${GROK_IMAGINE_2_MAX_INPUTS} 张参考图，当前收到 ${inputImages.length} 张`,
    )
  }
  if (request.mask) {
    grokClientError('该模型不支持遮罩编辑（上游无 mask 能力），请换 GPT 模型或去掉遮罩')
  }
  return request
}

const GROK_CONTACT_SHEET_MAX_SIDE = 2048

const GROK_CONTACT_SHEET_MAX_INPUTS = 16

const GROK_CONTACT_SHEET_GAP = 16

const GROK_CONTACT_SHEET_LABEL_HEIGHT = 64

/**
 * Grok edits only accept one image. Combine multiple inputs into a numbered contact sheet.
 */
export async function normalizeGrokEditInputs(
  request: HydratedSubmitRequest,
  signal: AbortSignal,
): Promise<HydratedSubmitRequest> {
  signal.throwIfAborted()
  const inputImages = request.input_images ?? []
  if (inputImages.length > GROK_CONTACT_SHEET_MAX_INPUTS) {
    throw new Error(
      `Grok contact sheet 最多支持 ${GROK_CONTACT_SHEET_MAX_INPUTS} 张参考图，当前收到 ${inputImages.length} 张`,
    )
  }
  if (inputImages.length > 1 && request.mask) {
    throw new Error(
      'Grok 编辑不支持“多张参考图 + 遮罩”：原始遮罩坐标无法映射到 contact sheet，请只保留一张参考图或移除遮罩',
    )
  }
  if (inputImages.length <= 1) return request

  const columns = Math.ceil(Math.sqrt(inputImages.length))
  const rows = Math.ceil(inputImages.length / columns)
  const gap = Math.min(
    GROK_CONTACT_SHEET_GAP,
    Math.floor(GROK_CONTACT_SHEET_MAX_SIDE / (Math.max(columns, rows) * 8)),
  )
  const cellWidth = Math.max(
    1,
    Math.floor((GROK_CONTACT_SHEET_MAX_SIDE - gap * (columns - 1)) / columns),
  )
  const rowHeight = Math.max(2, Math.floor((GROK_CONTACT_SHEET_MAX_SIDE - gap * (rows - 1)) / rows))
  const labelHeight = Math.min(
    GROK_CONTACT_SHEET_LABEL_HEIGHT,
    Math.max(1, Math.floor(rowHeight / 5)),
  )
  const imageSide = Math.max(1, Math.min(cellWidth, rowHeight - labelHeight))
  const sheetWidth = columns * imageSide + gap * (columns - 1)
  const sheetHeight = rows * (imageSide + labelHeight) + gap * (rows - 1)

  const tiles: Array<{ image: Buffer; label: Buffer }> = []
  for (const [index, dataUrl] of inputImages.entries()) {
    const { bytes } = decodeDataUrl(dataUrl)
    signal.throwIfAborted()
    const image = await sharp(bytes)
      .rotate()
      .resize(imageSide, imageSide, {
        fit: 'contain',
        background: { r: 245, g: 245, b: 245, alpha: 1 },
      })
      .png()
      .toBuffer()
    signal.throwIfAborted()
    tiles.push({ image, label: buildTileLabelSvg(index, imageSide, labelHeight) })
  }

  const overlays = tiles.flatMap(({ image, label }, index) => {
    const column = index % columns
    const row = Math.floor(index / columns)
    const left = column * (imageSide + gap)
    const top = row * (imageSide + labelHeight + gap)
    return [
      { input: image, left, top },
      { input: label, left, top: top + imageSide },
    ]
  })
  signal.throwIfAborted()
  const sheet = await sharp({
    create: {
      width: sheetWidth,
      height: sheetHeight,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite(overlays)
    .png()
    .toBuffer()
  signal.throwIfAborted()

  return {
    ...request,
    input_images: [`data:image/png;base64,${sheet.toString('base64')}`],
  }
}

function buildTileLabelSvg(index: number, width: number, height: number): Buffer {
  const fontSize = Math.max(12, Math.min(28, Math.floor(height * 0.44)))
  return Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">` +
      '<rect width="100%" height="100%" fill="#111827"/>' +
      '<text x="24" y="50%" dy="0.35em" fill="#ffffff" font-family="sans-serif" ' +
      `font-size="${fontSize}" font-weight="700">Image ${index + 1}</text>` +
      '</svg>',
  )
}
