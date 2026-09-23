// PROTOTYPE — throwaway (prototype/image-toolbox 分支)。
// 三个变体共用的真实处理：只为让原型里的尺寸与体积数字是真的，不是正式实现。
// 故意没接 @jsquash：Safari 选 WebP、任何浏览器选 AVIF 都会被 canvas 静默回退成 PNG，
// 原型把这件事显示成「已回退 PNG」角标，正式实现按 ROADMAP C5 的裁决用 wasm 补齐。

import { zipSync } from 'fflate'
import { canvasToBlob } from '../../../lib/canvasImage'
import { downloadBlob } from '../../../lib/downloadImages'

export type OutputFormat = 'keep' | 'image/jpeg' | 'image/png' | 'image/webp' | 'image/avif'

export const FORMAT_LABELS: Record<OutputFormat, string> = {
  keep: '保持原格式',
  'image/jpeg': 'JPG',
  'image/png': 'PNG',
  'image/webp': 'WebP',
  'image/avif': 'AVIF',
}

export type ResizeMode = 'none' | 'longEdge' | 'width' | 'percent'

export interface CropPreset {
  label: string
  ratio: number | null
  size?: readonly [number, number]
}

export const CROP_PRESETS = {
  none: { label: '原图', ratio: null },
  '1:1': { label: '1:1', ratio: 1 },
  '4:3': { label: '4:3', ratio: 4 / 3 },
  '3:4': { label: '3:4', ratio: 3 / 4 },
  '16:9': { label: '16:9', ratio: 16 / 9 },
  '9:16': { label: '9:16', ratio: 9 / 16 },
  taobao: { label: '淘宝主图 800×800', ratio: 1, size: [800, 800] },
  amazon: { label: 'Amazon 2000×2000', ratio: 1, size: [2000, 2000] },
  xhs: { label: '小红书 1242×1660', ratio: 1242 / 1660, size: [1242, 1660] },
  douyin: { label: '抖音 1080×1920', ratio: 9 / 16, size: [1080, 1920] },
  wechat: { label: '公众号封面 900×383', ratio: 900 / 383, size: [900, 383] },
} satisfies Record<string, CropPreset>

export type CropPresetId = keyof typeof CROP_PRESETS

export interface Recipe {
  resizeMode: ResizeMode
  resizeValue: number
  crop: CropPresetId
  /** 裁剪框中心在可移动范围里的位置，0–1。 */
  cropX: number
  cropY: number
  rotate: 0 | 90 | 180 | 270
  flipH: boolean
  flipV: boolean
  format: OutputFormat
  compressMode: 'quality' | 'target'
  quality: number
  targetKb: number
}

export const DEFAULT_RECIPE: Recipe = {
  resizeMode: 'none',
  resizeValue: 1600,
  crop: 'none',
  cropX: 0.5,
  cropY: 0.5,
  rotate: 0,
  flipH: false,
  flipV: false,
  format: 'keep',
  compressMode: 'quality',
  quality: 80,
  targetKb: 200,
}

export interface ProcessedImage {
  blob: Blob
  width: number
  height: number
  /** 请求的格式浏览器编不出来，canvas 按规范静默给了 PNG。 */
  fellBack: boolean
  /** 目标体积模式下最低质量仍超出目标。 */
  overTarget: boolean
}

const IOS =
  /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
/** WebKit CanvasBase.cpp：iOS 8192²，其余 16384²；Chromium 32768×8192；Firefox 单边 32767。 */
const MAX_AREA = IOS ? 8192 * 8192 : 16384 * 16384
const MAX_SIDE = 32767

export class CanvasLimitError extends Error {
  constructor(width: number, height: number) {
    super(`输出 ${width}×${height} 超出浏览器画布上限`)
  }
}

function assertFits(width: number, height: number) {
  if (width * height > MAX_AREA || width > MAX_SIDE || height > MAX_SIDE)
    throw new CanvasLimitError(width, height)
}

function createCanvas(width: number, height: number) {
  assertFits(width, height)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 不可用')
  ctx.imageSmoothingQuality = 'high'
  return { canvas, ctx }
}

const ENCODABLE: Record<string, true> = {
  'image/jpeg': true,
  'image/png': true,
  'image/webp': true,
}

export function resolveFormat(format: OutputFormat, sourceType: string): string {
  if (format !== 'keep') return format
  return ENCODABLE[sourceType] ? sourceType : 'image/png'
}

export function extensionFor(type: string): string {
  if (type === 'image/jpeg') return 'jpg'
  return type.split('/')[1] ?? 'png'
}

/** 旋转 / 翻转后的整幅、裁剪区域与最终输出尺寸。纯计算，三个变体的预览叠框也用它。 */
export function planGeometry(sourceWidth: number, sourceHeight: number, recipe: Recipe) {
  const swap = recipe.rotate === 90 || recipe.rotate === 270
  const rw = swap ? sourceHeight : sourceWidth
  const rh = swap ? sourceWidth : sourceHeight
  const preset: CropPreset = CROP_PRESETS[recipe.crop]
  let sx = 0
  let sy = 0
  let sw = rw
  let sh = rh
  if (preset.ratio) {
    if (rw / rh > preset.ratio) {
      sw = Math.round(rh * preset.ratio)
      sx = Math.round((rw - sw) * recipe.cropX)
    } else {
      sh = Math.round(rw / preset.ratio)
      sy = Math.round((rh - sh) * recipe.cropY)
    }
  }
  let tw = sw
  let th = sh
  if (preset.size) {
    ;[tw, th] = preset.size
  } else if (recipe.resizeMode !== 'none' && recipe.resizeValue > 0) {
    const scale =
      recipe.resizeMode === 'longEdge'
        ? Math.min(1, recipe.resizeValue / Math.max(sw, sh))
        : recipe.resizeMode === 'width'
          ? recipe.resizeValue / sw
          : recipe.resizeValue / 100
    tw = Math.max(1, Math.round(sw * scale))
    th = Math.max(1, Math.round(sh * scale))
  }
  return { rotated: { width: rw, height: rh }, crop: { sx, sy, sw, sh }, output: { tw, th } }
}

async function encodeToTarget(canvas: HTMLCanvasElement, type: string, targetBytes: number) {
  let lo = 0.05
  let hi = 0.95
  let best: Blob | null = null
  for (let i = 0; i < 7; i++) {
    const q = (lo + hi) / 2
    const blob = await canvasToBlob(canvas, type, q)
    if (blob.size <= targetBytes) {
      best = blob
      lo = q
    } else hi = q
  }
  const blob = best ?? (await canvasToBlob(canvas, type, 0.05))
  return { blob, overTarget: blob.size > targetBytes }
}

export async function processImage(
  source: ImageBitmap,
  sourceType: string,
  recipe: Recipe,
): Promise<ProcessedImage> {
  const plan = planGeometry(source.width, source.height, recipe)
  const oriented = createCanvas(plan.rotated.width, plan.rotated.height)
  oriented.ctx.translate(plan.rotated.width / 2, plan.rotated.height / 2)
  oriented.ctx.rotate((recipe.rotate * Math.PI) / 180)
  oriented.ctx.scale(recipe.flipH ? -1 : 1, recipe.flipV ? -1 : 1)
  oriented.ctx.drawImage(source, -source.width / 2, -source.height / 2)

  const type = resolveFormat(recipe.format, sourceType)
  const { tw, th } = plan.output
  const { sx, sy, sw, sh } = plan.crop
  const out = createCanvas(tw, th)
  if (type === 'image/jpeg') {
    out.ctx.fillStyle = '#fff'
    out.ctx.fillRect(0, 0, tw, th)
  }
  out.ctx.drawImage(oriented.canvas, sx, sy, sw, sh, 0, 0, tw, th)

  const lossy = type !== 'image/png'
  let blob: Blob
  let overTarget = false
  if (lossy && recipe.compressMode === 'target') {
    ;({ blob, overTarget } = await encodeToTarget(out.canvas, type, recipe.targetKb * 1024))
  } else {
    blob = await canvasToBlob(out.canvas, type, lossy ? recipe.quality / 100 : undefined)
  }
  return { blob, width: tw, height: th, fellBack: blob.type !== type, overTarget }
}

export interface ComposeOptions {
  mode: 'collage' | 'stitch' | 'slice'
  direction: 'vertical' | 'horizontal'
  columns: number
  gap: number
  background: string
  rows: number
  squareFirst: boolean
}

export const DEFAULT_COMPOSE: ComposeOptions = {
  mode: 'stitch',
  direction: 'vertical',
  columns: 3,
  gap: 0,
  background: '#ffffff',
  rows: 3,
  squareFirst: true,
}

function drawCover(
  ctx: CanvasRenderingContext2D,
  source: ImageBitmap,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const scale = Math.max(w / source.width, h / source.height)
  const sw = w / scale
  const sh = h / scale
  ctx.drawImage(source, (source.width - sw) / 2, (source.height - sh) / 2, sw, sh, x, y, w, h)
}

/** 长图拼接：竖拼统一到最窄的宽度，横拼统一到最矮的高度，不放大任何一张。 */
function stitch(sources: ImageBitmap[], o: ComposeOptions): HTMLCanvasElement {
  const vertical = o.direction === 'vertical'
  const edge = Math.min(...sources.map((s) => (vertical ? s.width : s.height)))
  const lengths = sources.map((s) =>
    Math.round(vertical ? (s.height * edge) / s.width : (s.width * edge) / s.height),
  )
  const total = lengths.reduce((a, b) => a + b, 0) + o.gap * (sources.length - 1)
  const { canvas, ctx } = vertical ? createCanvas(edge, total) : createCanvas(total, edge)
  ctx.fillStyle = o.background
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  let offset = 0
  sources.forEach((s, i) => {
    if (vertical) ctx.drawImage(s, 0, offset, edge, lengths[i])
    else ctx.drawImage(s, offset, 0, lengths[i], edge)
    offset += lengths[i] + o.gap
  })
  return canvas
}

/** 宫格拼图：等大正方格，每张居中铺满。 */
function collage(sources: ImageBitmap[], o: ComposeOptions): HTMLCanvasElement {
  const cols = Math.max(1, Math.min(o.columns, sources.length))
  const rows = Math.ceil(sources.length / cols)
  const cell = Math.min(1200, Math.min(...sources.map((s) => Math.min(s.width, s.height))))
  const { canvas, ctx } = createCanvas(
    cols * cell + (cols + 1) * o.gap,
    rows * cell + (rows + 1) * o.gap,
  )
  ctx.fillStyle = o.background
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  sources.forEach((s, i) => {
    const x = o.gap + (i % cols) * (cell + o.gap)
    const y = o.gap + Math.floor(i / cols) * (cell + o.gap)
    drawCover(ctx, s, x, y, cell, cell)
  })
  return canvas
}

/** 九宫格切图：可选先裁成正方形，再按行列切成若干张。 */
function slice(source: ImageBitmap, o: ComposeOptions): HTMLCanvasElement[] {
  const side = Math.min(source.width, source.height)
  const w = o.squareFirst ? side : source.width
  const h = o.squareFirst ? side : source.height
  const base = createCanvas(w, h)
  drawCover(base.ctx, source, 0, 0, w, h)
  const cols = Math.max(1, o.columns)
  const rows = Math.max(1, o.rows)
  const cw = Math.floor(w / cols)
  const ch = Math.floor(h / rows)
  const tiles: HTMLCanvasElement[] = []
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const tile = createCanvas(cw, ch)
      tile.ctx.drawImage(base.canvas, c * cw, r * ch, cw, ch, 0, 0, cw, ch)
      tiles.push(tile.canvas)
    }
  return tiles
}

export interface ComposedOutput {
  blob: Blob
  width: number
  height: number
}

export async function compose(
  sources: ImageBitmap[],
  options: ComposeOptions,
): Promise<ComposedOutput[]> {
  if (sources.length === 0) return []
  const canvases =
    options.mode === 'slice'
      ? slice(sources[0], options)
      : [options.mode === 'stitch' ? stitch(sources, options) : collage(sources, options)]
  return Promise.all(
    canvases.map(async (canvas) => ({
      blob: await canvasToBlob(canvas, 'image/jpeg', 0.9),
      width: canvas.width,
      height: canvas.height,
    })),
  )
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 2 : 1)} MB`
}

export function savingLabel(before: number, after: number): string {
  const delta = Math.round((1 - after / before) * 100)
  return delta >= 0 ? `−${delta}%` : `+${-delta}%`
}

export function outputName(name: string, type: string, suffix = ''): string {
  const base = name.replace(/\.[^.]+$/, '')
  return `${base}${suffix}.${extensionFor(type)}`
}

export async function downloadAll(entries: { name: string; blob: Blob }[], zipName: string) {
  if (entries.length === 0) return
  if (entries.length === 1) {
    downloadBlob(entries[0].blob, entries[0].name)
    return
  }
  const used = new Set<string>()
  const files: Record<string, Uint8Array> = {}
  for (const entry of entries) {
    let name = entry.name
    for (let n = 2; used.has(name); n++) name = entry.name.replace(/(\.[^.]+)$/, `-${n}$1`)
    used.add(name)
    files[name] = new Uint8Array(await entry.blob.arrayBuffer())
  }
  downloadBlob(
    new Blob([zipSync(files, { level: 0 }) as BlobPart], { type: 'application/zip' }),
    zipName,
  )
}
