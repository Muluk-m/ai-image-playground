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
  maskDataUrlToAlpha,
  matteAgreesWithBox,
  type ProductAlpha,
  ProductMatteError,
  type SegmentFailureReason,
  segmentProduct,
} from '../../../lib/productMatte'
import { ensureImageCached } from '../../../store'
import type { MatteAgreement, MatteOutcome, MatteSource, SourceMatte } from '../types'
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

export function pendingMatte(): SourceMatte {
  return {
    status: 'pending',
    source: null,
    alphaImageId: null,
    previewImageId: null,
    maskImageId: null,
    maskTargetImageId: null,
    elapsedMs: null,
    agreement: null,
    backend: null,
    reason: null,
    edited: false,
  }
}

interface Segmented {
  raw: ProductAlpha
  source: MatteSource
  backend: SourceMatte['backend']
}

async function segment(dataUrl: string): Promise<Segmented> {
  const server = isClientCapabilityEnabled('matte:server') ? await serverAlpha(dataUrl) : null
  if (server) return { raw: server, source: 'server', backend: null }
  const matte = await segmentProduct(dataUrl)
  return { raw: matte, source: 'browser', backend: matte.backend }
}

/** 服务端抠不出来就落回浏览器链。 */
async function serverAlpha(dataUrl: string): Promise<ProductAlpha | null> {
  try {
    return await maskDataUrlToAlpha((await requestServerMatte(dataUrl)).alpha)
  } catch {
    return null
  }
}

type MatteMeta = Pick<SourceMatte, 'source' | 'backend' | 'elapsedMs' | 'maskTargetImageId'>

/** 抠出的 alpha → 落盘的蒙版记录。产品框可以缺席：那时只是不做回捞也不校验。 */
async function settle(
  raw: ProductAlpha,
  productBox: ProductBox | null,
  meta: MatteMeta,
): Promise<SourceMatte> {
  const base = { ...pendingMatte(), ...meta }
  if (!assessMatte(raw).ok) {
    // 抠错的那次预览照实存：用户就是靠它看出抠到了什么。
    return { ...base, status: 'failed', reason: 'failed', previewImageId: await preview(raw) }
  }

  const agreement: MatteAgreement | null = productBox
    ? matteAgreesWithBox(raw, productBox)
      ? 'ok'
      : 'box-mismatch'
    : null
  // 校验看原始蒙版；膨胀后的那张才是真正用掉的，预览与它一致用户才看得出附件有没有进保留区。
  const used = agreement === 'box-mismatch' ? raw : expandProductAlpha(raw, { productBox })
  return {
    ...base,
    status: 'ready',
    agreement,
    previewImageId: await preview(used),
    alphaImageId: await storeImage(alphaToDataUrl(raw), 'mask'),
    maskImageId:
      agreement === 'box-mismatch' ? null : await storeImage(alphaToInpaintMask(used), 'mask'),
  }
}

function preview(matte: ProductAlpha): Promise<string> {
  return storeImage(alphaToMattePreview(matte), 'mask')
}

/** 抠一张原图。抠不出来记 failed，动作那边回落成提示词版。 */
export async function runSourceMatte(
  imageId: string,
  dataUrl: string,
  productBox: ProductBox | null,
): Promise<SourceMatte> {
  const startedAt = Date.now()
  try {
    const { raw, source, backend } = await segment(dataUrl)
    return await settle(raw, productBox, {
      source,
      backend,
      elapsedMs: Date.now() - startedAt,
      maskTargetImageId: imageId,
    })
  } catch (error) {
    const reason = error instanceof ProductMatteError ? error.reason : 'failed'
    return { ...pendingMatte(), status: 'failed', reason, elapsedMs: Date.now() - startedAt }
  }
}

/** 方案给出产品框后补做一次：框内附件回捞与一致性校验都要框，抠图跑在方案之前。 */
export async function applyProductBox(
  matte: SourceMatte,
  productBox: ProductBox,
): Promise<SourceMatte> {
  if (matte.status !== 'ready' || matte.edited || matte.agreement !== null) return matte
  try {
    const alphaDataUrl = matte.alphaImageId ? await ensureImageCached(matte.alphaImageId) : null
    if (!alphaDataUrl) return matte
    return await settle(await maskDataUrlToAlpha(alphaDataUrl), productBox, {
      source: matte.source,
      backend: matte.backend,
      elapsedMs: matte.elapsedMs,
      maskTargetImageId: matte.maskTargetImageId,
    })
  } catch {
    // 读不回原始 alpha 就留着未校验的那份，别把动作一起拖垮。
    return matte
  }
}

function outcomeOf(matte: SourceMatte): MatteOutcome {
  return {
    ok: true,
    elapsedMs: matte.elapsedMs ?? 0,
    ...(matte.backend ? { backend: matte.backend } : {}),
  }
}

/** 原图的蒙版 → 这一次动作要提交的遮罩。`side` 决定重绘哪一侧。 */
export async function maskAttemptFor(matte: SourceMatte, side: MaskSide): Promise<MaskAttempt> {
  if (matte.status === 'failed') {
    return unmasked(MATTE_FAILED, matte.reason ?? 'failed', matte.previewImageId)
  }
  if (matte.agreement === 'box-mismatch' && !matte.edited) {
    return unmasked(MATTE_UNRELIABLE, 'box-mismatch', matte.previewImageId)
  }
  if (!matte.maskImageId || !matte.maskTargetImageId) {
    return unmasked(MATTE_FAILED, 'failed', matte.previewImageId)
  }

  const attempt = { notice: null, matte: outcomeOf(matte), previewImageId: matte.previewImageId }
  if (side === 'background') {
    return {
      ...attempt,
      mask: { imageId: matte.maskImageId, targetImageId: matte.maskTargetImageId },
    }
  }

  const productMaskId = await productMaskFrom(matte.maskImageId)
  if (!productMaskId) return unmasked(MATTE_FAILED, 'failed', matte.previewImageId)
  return {
    ...attempt,
    mask: { imageId: productMaskId, targetImageId: matte.maskTargetImageId },
  }
}

/** 保留侧遮罩 → 产品侧遮罩。取不回来就当没抠到，动作回落成提示词版。 */
async function productMaskFrom(maskImageId: string): Promise<string | null> {
  try {
    const maskDataUrl = await ensureImageCached(maskImageId)
    if (!maskDataUrl) return null
    return await storeImage(alphaToProductMask(await maskDataUrlToAlpha(maskDataUrl)), 'mask')
  } catch {
    return null
  }
}
