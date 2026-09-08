import type { ProductBox } from '@image-playground/shared'
import { isClientCapabilityEnabled } from '../../../lib/clientCapabilities'
import { storeImage } from '../../../lib/db'
import { requestServerMatte } from '../../../lib/matteClient'
import {
  alphaToDataUrl,
  alphaToInpaintMask,
  alphaToMattePreview,
  alphaToProductMask,
  assessMatte,
  expandProductAlpha,
  type MatteBackendId,
  maskDataUrlToAlpha,
  matteAgreesWithBox,
  type ProductAlpha,
  ProductMatteError,
  type SegmentFailureReason,
  segmentProduct,
} from '../../../lib/productMatte'
import { ensureImageCached } from '../../../store'
import type { MatteAgreement, MatteOutcome, SourceMatte } from '../types'
import type { MaskSide } from './mode'

export const UNMASKED_FALLBACK = '本版未抠图'
export const MATTE_FAILED = `抠图失败，${UNMASKED_FALLBACK}`
export const MATTE_UNRELIABLE = `蒙版与产品框不符，${UNMASKED_FALLBACK}`

export type Mask = { imageId: string; targetImageId: string }

export interface MaskAttempt {
  mask: Mask | null
  /** 蒙版回落的说明，没有回落时为 null。 */
  notice: string | null
  /** 这一模式不带遮罩时为 null，没跑过抠图也就没有结论。 */
  matte: MatteOutcome | null
  /** 蒙版叠在原图上的预览图；抠图没跑出结果时为 null。 */
  previewImageId: string | null
  /** 这次按产品框算出的一致性，写回原图只为芯片；方案没给框时缺席。 */
  agreement?: MatteAgreement
}

/** 整图重画的那几种动作不带遮罩。 */
export const NO_MASK: MaskAttempt = { mask: null, notice: null, matte: null, previewImageId: null }

export function unmasked(
  notice: string,
  reason: SegmentFailureReason | 'box-mismatch',
  previewImageId: string | null,
): MaskAttempt {
  return { mask: null, notice, matte: { ok: false, reason }, previewImageId }
}

interface RawMatte {
  alpha: ProductAlpha
  /** 落盘的那张 alpha PNG。服务端那张原样存，不解码再编码一遍。 */
  dataUrl: string
  backend: MatteBackendId
}

async function segment(dataUrl: string): Promise<RawMatte> {
  const server = isClientCapabilityEnabled('matte:server') ? await serverMatte(dataUrl) : null
  return server ?? (await browserMatte(dataUrl))
}

/** 服务端抠不出来就落回浏览器链。 */
async function serverMatte(dataUrl: string): Promise<RawMatte | null> {
  try {
    const { alpha } = await requestServerMatte(dataUrl)
    return {
      alpha: await maskDataUrlToAlpha(alpha),
      dataUrl: alpha,
      backend: 'cloudflare-birefnet',
    }
  } catch {
    return null
  }
}

async function browserMatte(dataUrl: string): Promise<RawMatte> {
  const matte = await segmentProduct(dataUrl)
  return { alpha: matte, dataUrl: alphaToDataUrl(matte), backend: matte.backend }
}

/** 抠一张原图。抠不出来记 failed，动作那边回落成提示词版。 */
export async function runSourceMatte(imageId: string, dataUrl: string): Promise<SourceMatte> {
  try {
    const raw = await segment(dataUrl)
    const previewImageId = await storeImage(alphaToMattePreview(raw.alpha), 'mask')
    // 抠错的那次预览照实存：用户就是靠它看出抠到了什么。
    if (!assessMatte(raw.alpha).ok) return { status: 'failed', reason: 'failed', previewImageId }
    return {
      status: 'ready',
      backend: raw.backend,
      alphaImageId: await storeImage(raw.dataUrl, 'mask'),
      targetImageId: imageId,
      previewImageId,
      edited: false,
    }
  } catch (error) {
    const reason = error instanceof ProductMatteError ? error.reason : 'failed'
    return { status: 'failed', reason, previewImageId: null }
  }
}

/** 原图的 alpha → 这一次动作要提交的遮罩。`side` 决定重绘哪一侧，产品框决定回捞与校验。 */
export async function maskAttemptFor(
  matte: SourceMatte,
  productBox: ProductBox | null,
  side: MaskSide,
): Promise<MaskAttempt> {
  if (matte.status === 'failed') {
    return unmasked(MATTE_FAILED, matte.reason, matte.previewImageId)
  }

  try {
    const raw = await readAlpha(matte.alphaImageId)
    if (!raw) return unmasked(MATTE_FAILED, 'failed', matte.previewImageId)

    // 手改的那份就是最终答案，既不回捞也不再校验。
    if (matte.edited) return await masked(matte, raw, side, 'ok')

    const agreement: MatteAgreement | undefined = productBox
      ? matteAgreesWithBox(raw, productBox)
        ? 'ok'
        : 'box-mismatch'
      : undefined
    if (agreement === 'box-mismatch') {
      return { ...unmasked(MATTE_UNRELIABLE, 'box-mismatch', matte.previewImageId), agreement }
    }
    return await masked(matte, expandProductAlpha(raw, { productBox }), side, agreement)
  } catch {
    return unmasked(MATTE_FAILED, 'failed', matte.previewImageId)
  }
}

async function readAlpha(alphaImageId: string): Promise<ProductAlpha | null> {
  const dataUrl = await ensureImageCached(alphaImageId)
  return dataUrl ? await maskDataUrlToAlpha(dataUrl) : null
}

async function masked(
  matte: Extract<SourceMatte, { status: 'ready' }>,
  alpha: ProductAlpha,
  side: MaskSide,
  agreement: MatteAgreement | undefined,
): Promise<MaskAttempt> {
  const mask = side === 'background' ? alphaToInpaintMask(alpha) : alphaToProductMask(alpha)
  return {
    mask: { imageId: await storeImage(mask, 'mask'), targetImageId: matte.targetImageId },
    notice: null,
    matte: { ok: true, backend: matte.backend },
    previewImageId: matte.previewImageId,
    ...(agreement ? { agreement } : {}),
  }
}
