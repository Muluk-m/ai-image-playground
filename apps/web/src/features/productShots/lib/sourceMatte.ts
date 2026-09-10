import { IMAGE_DATA_URL_MAX_CHARS, type ProductBox } from '@image-playground/shared'
import { getActiveApiProfile } from '../../../lib/apiProfiles'
import { isModelKnown, modelSupportsNativeMask } from '../../../lib/channels/profileSelectors'
import { getPublicChannels } from '../../../lib/channels/publicChannels'
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
  filterProductAlpha,
  logMatteFailure,
  type MatteBackendId,
  maskDataUrlToAlpha,
  matteAgreesWithBox,
  type ProductAlpha,
  ProductMatteError,
  segmentProduct,
} from '../../../lib/productMatte'
import { ensureImageCached, useStore } from '../../../store'
import type { AppSettings, InputImage } from '../../../types'
import {
  type MatteAgreement,
  type MatteFailureCause,
  type MatteOutcome,
  matteEditable,
  type ProductShotImage,
  type SourceMatte,
} from '../types'
import type { MaskSide } from './mode'

const UNMASKED_FALLBACK = '本版未抠图'
const MATTE_FAILED = `抠图失败，${UNMASKED_FALLBACK}`
const MATTE_UNRELIABLE = `蒙版与产品框不符，${UNMASKED_FALLBACK}`
const MASK_UNSUPPORTED = `当前模型不支持遮罩，${UNMASKED_FALLBACK}`
const MATTE_MISSING = '本地蒙版数据已丢失，请重试抠图'

type Mask = { imageId: string; targetImageId: string }

export interface MaskAttempt {
  mask: Mask | null
  /** 蒙版回落的说明，没有回落时为 null。 */
  notice: string | null
  /** 这一模式不带遮罩时为 null，没跑过抠图也就没有结论。 */
  matte: MatteOutcome | null
  /** 蒙版叠在原图上的预览图；抠图没跑出结果时为 null。 */
  previewImageId: string | null
}

interface DerivedMask extends MaskAttempt {
  /** 这次按产品框算出的一致性，写回原图只为芯片；方案没给框时缺席。 */
  agreement?: MatteAgreement
}

/** 整图重画的那几种动作不带遮罩。 */
export const NO_MASK: MaskAttempt = { mask: null, notice: null, matte: null, previewImageId: null }

function unmasked(
  notice: string,
  reason: MatteFailureCause,
  previewImageId: string | null,
): MaskAttempt {
  return { mask: null, notice, matte: { ok: false, reason }, previewImageId }
}

export interface SourceMatteRef {
  jobId: string
  imageId: string
}

/** 状态更新在最新原图上同步求值，返回后等待持久化完成。 */
export interface SourceMatteHost {
  read(source: SourceMatteRef): ProductShotImage | undefined
  update(
    source: SourceMatteRef,
    transform: (image: ProductShotImage) => ProductShotImage,
  ): Promise<void>
  pendingChanged(): void
}

interface SourceLifetime {
  source: SourceMatteRef
  valid: boolean
  pending?: Promise<void>
  editRevision: number
}

/** 同一图片可用于多个任务；删除后再添加则是另一份原图生命周期。 */
export function createSourceMattes(host: SourceMatteHost) {
  const jobs = new Map<string, Map<string, SourceLifetime>>()

  function lifetime(source: SourceMatteRef): SourceLifetime | undefined {
    if (!host.read(source)) return undefined
    let images = jobs.get(source.jobId)
    if (!images) {
      images = new Map()
      jobs.set(source.jobId, images)
    }
    let entry = images.get(source.imageId)
    if (!entry) {
      entry = { source, valid: true, editRevision: 0 }
      images.set(source.imageId, entry)
    }
    return entry
  }

  function live(entry: SourceLifetime): boolean {
    return entry.valid && host.read(entry.source) !== undefined
  }

  async function markMissing(entry: SourceLifetime, matte: SourceMatte): Promise<void> {
    await host.update(entry.source, (image) =>
      live(entry) && image.sourceMatte === matte
        ? {
            ...image,
            sourceMatte: { status: 'failed', reason: 'missing', previewImageId: null },
          }
        : image,
    )
  }

  async function run(entry: SourceLifetime): Promise<void> {
    let matte: SourceMatte
    try {
      const dataUrl = await ensureImageCached(entry.source.imageId)
      if (!live(entry)) return
      if (!dataUrl) throw new Error('原图已不在本地')
      matte = await runSourceMatte(entry.source.imageId, dataUrl)
    } catch {
      matte = { status: 'failed', reason: 'failed', previewImageId: null }
    }
    if (!live(entry)) return
    await host.update(entry.source, (image) =>
      live(entry) && !image.sourceMatte ? { ...image, sourceMatte: matte } : image,
    )
  }

  function ensure(source: SourceMatteRef): Promise<void> {
    const entry = lifetime(source)
    if (!entry) return Promise.resolve()
    if (entry.pending) return entry.pending
    if (host.read(source)?.sourceMatte || !maskSupported()) return Promise.resolve()
    const pending = run(entry).finally(() => {
      entry.pending = undefined
      host.pendingChanged()
    })
    entry.pending = pending
    host.pendingChanged()
    return pending
  }

  return {
    ensure,
    /** 「重试抠图」：丢掉失败那条记录再抠一次，`ensure` 见到空的才会重跑。 */
    async retry(source: SourceMatteRef): Promise<void> {
      const entry = lifetime(source)
      if (!entry || entry.pending) return
      await host.update(source, (image) => ({ ...image, sourceMatte: undefined }))
      await ensure(source)
    },
    async prepare(
      source: SourceMatteRef,
      input: { dataUrl: string; productBox: ProductBox | null; side: MaskSide },
    ): Promise<MaskAttempt & { image: InputImage }> {
      const entry = lifetime(source)
      if (!entry) throw new Error('原图已从任务移除')
      const original = { id: source.imageId, dataUrl: input.dataUrl }
      if (!maskSupported()) {
        return { ...unmasked(MASK_UNSUPPORTED, 'unsupported', null), image: original }
      }
      await ensure(source)
      if (!live(entry)) throw new Error('原图已从任务移除')
      const matte = host.read(source)?.sourceMatte
      if (!matte) return { ...unmasked(MATTE_FAILED, 'failed', null), image: original }

      // 这份 alpha 是本次动作的快照，之后的手改只影响下一次动作。
      const attempt = await maskAttemptFor(matte, input.productBox, input.side)
      if (!live(entry)) throw new Error('原图已从任务移除')
      if (attempt.matte?.ok === false && attempt.matte.reason === 'missing') {
        await markMissing(entry, matte)
        throw new Error(MATTE_MISSING)
      }
      if (matte.status === 'ready' && attempt.agreement && attempt.agreement !== matte.agreement) {
        const agreement = attempt.agreement
        await host.update(source, (image) =>
          live(entry) && image.sourceMatte === matte
            ? { ...image, sourceMatte: { ...matte, agreement } }
            : image,
        )
      }

      let image = original
      if (attempt.mask && attempt.mask.targetImageId !== source.imageId) {
        const dataUrl = await ensureImageCached(attempt.mask.targetImageId)
        if (!dataUrl) throw new Error('蒙版对应的原图已不在本地')
        image = { id: attempt.mask.targetImageId, dataUrl }
      }
      if (!live(entry)) throw new Error('原图已从任务移除')
      return {
        mask: attempt.mask,
        notice: attempt.notice,
        matte: attempt.matte,
        previewImageId: attempt.previewImageId,
        image,
      }
    },
    async edit(source: SourceMatteRef) {
      const entry = lifetime(source)
      const matte = host.read(source)?.sourceMatte
      // 占比不对的那份也能改：手改完就是可用的蒙版，这是用户唯一的出路。
      if (!entry || !matteEditable(matte)) return null
      const maskDataUrl = await ensureImageCached(matte.alphaImageId)
      if (!live(entry)) return null
      if (!maskDataUrl) {
        await markMissing(entry, matte)
        throw new Error(MATTE_MISSING)
      }
      return {
        maskDataUrl,
        targetImageId: matte.targetImageId,
        keepSemantics: true as const,
        onSave: async (saved: { maskDataUrl: string; targetImageId: string }): Promise<void> => {
          if (!live(entry)) return
          const revision = ++entry.editRevision
          const alphaImageId = await storeImage(saved.maskDataUrl, 'mask')
          let previewImageId = matte.previewImageId
          try {
            previewImageId = await storeImage(
              alphaToMattePreview(await maskDataUrlToAlpha(saved.maskDataUrl)),
              'mask',
            )
          } catch {
            // 预览失败不改变手改 alpha 的权威性。
          }
          if (!live(entry) || revision !== entry.editRevision) return
          await host.update(source, (image) =>
            live(entry) && revision === entry.editRevision
              ? {
                  ...image,
                  sourceMatte: {
                    status: 'ready',
                    backend: matte.backend,
                    alphaImageId,
                    targetImageId: saved.targetImageId,
                    previewImageId,
                    edited: true,
                    agreement: 'ok',
                  },
                }
              : image,
          )
        },
      }
    },
    pending(jobId: string | null): string[] {
      if (!jobId) return []
      const images = jobs.get(jobId)
      return images
        ? [...images.values()]
            .filter((entry) => entry.pending && live(entry))
            .map((entry) => entry.source.imageId)
        : []
    },
    forget(jobId: string, imageId?: string): void {
      const images = jobs.get(jobId)
      if (!images) return
      if (imageId === undefined) {
        for (const entry of images.values()) entry.valid = false
        jobs.delete(jobId)
      } else {
        const entry = images.get(imageId)
        if (entry) entry.valid = false
        images.delete(imageId)
        if (images.size === 0) jobs.delete(jobId)
      }
      host.pendingChanged()
    },
  }
}

export function maskSupported(settings: AppSettings = useStore.getState().settings): boolean {
  return modelSupportsNativeMask(getActiveApiProfile(settings), getPublicChannels())
}

export function modelKnown(settings: AppSettings = useStore.getState().settings): boolean {
  return isModelKnown(getActiveApiProfile(settings), getPublicChannels())
}

/** 服务端抠图是等网络，浏览器链吃满设备：一个放三个进去，一个一次只放一个。 */
const serverSlots = limiter(3)
const browserSlots = limiter(1)

function limiter(slots: number) {
  const waiting: Array<() => void> = []
  let free = slots
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (free === 0) await new Promise<void>((resolve) => waiting.push(resolve))
    else free -= 1
    try {
      return await task()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else free += 1
    }
  }
}

interface RawMatte {
  alpha: ProductAlpha
  /** 落盘的那张 alpha PNG。服务端那张原样存，不解码再编码一遍。 */
  dataUrl: string
  backend: MatteBackendId
  elapsedMs: number
}

/** 服务端挂了、浏览器链又跑不起来：这一次用户撞上的是服务端那次失败。 */
class ServerMatteFailure extends Error {}

async function segment(dataUrl: string): Promise<RawMatte> {
  if (!serverEligible(dataUrl)) return await browserSlots(() => browserMatte(dataUrl))
  const server = await serverSlots(() => serverMatte(dataUrl))
  if (server) return server
  try {
    return await browserSlots(() => browserMatte(dataUrl))
  } catch (error) {
    if (error instanceof ProductMatteError && error.reason === 'unsupported') {
      throw new ServerMatteFailure('服务端抠图失败')
    }
    throw error
  }
}

/** 超限的图路由会直接 400，别白跑一趟。 */
function serverEligible(dataUrl: string): boolean {
  return isClientCapabilityEnabled('matte:server') && dataUrl.length <= IMAGE_DATA_URL_MAX_CHARS
}

/** 服务端抠不出来就落回浏览器链。 */
async function serverMatte(dataUrl: string): Promise<RawMatte | null> {
  const startedAt = Date.now()
  try {
    const { alpha } = await requestServerMatte(dataUrl)
    return {
      alpha: await maskDataUrlToAlpha(alpha),
      dataUrl: alpha,
      backend: 'cloudflare-birefnet',
      elapsedMs: Date.now() - startedAt,
    }
  } catch (error) {
    logMatteFailure({
      backend: 'cloudflare-birefnet',
      reason: 'server',
      elapsedMs: Date.now() - startedAt,
      error,
    })
    return null
  }
}

async function browserMatte(dataUrl: string): Promise<RawMatte> {
  const matte = await segmentProduct(dataUrl)
  return {
    alpha: matte,
    dataUrl: alphaToDataUrl(matte),
    backend: matte.backend,
    elapsedMs: matte.elapsedMs,
  }
}

/** 抠一张原图。抠不出来记 failed，占比不对记 unusable，动作那边都不放行。 */
async function runSourceMatte(imageId: string, dataUrl: string): Promise<SourceMatte> {
  try {
    const raw = await segment(dataUrl)
    const assessment = assessMatte(raw.alpha)
    // 抠错的那次预览照实存：用户就是靠它看出抠到了什么。
    const [previewImageId, alphaImageId] = await Promise.all([
      storeImage(alphaToMattePreview(raw.alpha), 'mask'),
      storeImage(raw.dataUrl, 'mask'),
    ])
    const alpha = {
      backend: raw.backend,
      alphaImageId,
      targetImageId: imageId,
      previewImageId,
      edited: false,
    }
    if (assessment.ok) return { ...alpha, status: 'ready' }
    logMatteFailure({
      backend: raw.backend,
      reason: assessment.reason,
      elapsedMs: raw.elapsedMs,
      coverage: assessment.coverage,
    })
    return { ...alpha, status: 'unusable', reason: assessment.reason }
  } catch (error) {
    return { status: 'failed', reason: causeOf(error), previewImageId: null }
  }
}

function causeOf(error: unknown): MatteFailureCause {
  if (error instanceof ServerMatteFailure) return 'server'
  return error instanceof ProductMatteError ? error.reason : 'failed'
}

/** 原图的 alpha → 这一次动作要提交的遮罩。`side` 决定重绘哪一侧，产品框决定回捞与校验。 */
async function maskAttemptFor(
  matte: SourceMatte,
  productBox: ProductBox | null,
  side: MaskSide,
): Promise<DerivedMask> {
  if (matte.status !== 'ready') {
    return unmasked(MATTE_FAILED, matte.reason, matte.previewImageId)
  }

  try {
    const raw = await readAlpha(matte.alphaImageId)
    if (!raw) return unmasked(MATTE_MISSING, 'missing', matte.previewImageId)

    // 手改的那份就是最终答案，既不回捞也不再校验。
    if (matte.edited) return await masked(matte, raw, side, 'ok')

    const product = filterProductAlpha(raw, productBox)
    const agreement: MatteAgreement | undefined = productBox
      ? matteAgreesWithBox(product, productBox)
        ? 'ok'
        : 'box-mismatch'
      : undefined
    if (agreement === 'box-mismatch') {
      return { ...unmasked(MATTE_UNRELIABLE, 'box-mismatch', matte.previewImageId), agreement }
    }
    return await masked(matte, expandProductAlpha(product, { productBox }), side, agreement)
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
): Promise<DerivedMask> {
  const mask = side === 'background' ? alphaToInpaintMask(alpha) : alphaToProductMask(alpha)
  return {
    mask: { imageId: await storeImage(mask, 'mask'), targetImageId: matte.targetImageId },
    notice: null,
    matte: { ok: true, backend: matte.backend },
    previewImageId: matte.previewImageId,
    ...(agreement ? { agreement } : {}),
  }
}
