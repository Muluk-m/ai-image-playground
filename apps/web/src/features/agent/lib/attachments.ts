import {
  AGENT_TURN_MAX_INLINE_REFERENCES,
  AGENT_TURN_MAX_REFERENCES,
} from '@image-playground/shared'
import { i18next } from '../../../i18n'
import { getAttachmentLimits } from '../../../lib/clientCapabilities'
import { blobDataUrl } from '../../../lib/cloudMedia'
import { IMAGE_PREPROCESSING, preprocessImageFile } from '../../../lib/imagePreprocessing'
import { jpegOrientation } from '../../../lib/imagePreprocessing/orientation'
import { registerLocalAttachmentSource } from '../../../lib/localAttachmentSources'
import {
  attachReferences as admitReferences,
  type ReferenceRefusal,
} from '../../../lib/referenceDraft'
import { useStore } from '../../../store'
import { assetViewImages, useLibraryStore } from '../../library/store'
import { attachmentUploadsEnabled, mediaFallbackEnabled } from './attachmentUploads'
import {
  type AgentDraft,
  type AgentReference,
  type AttachedReference,
  agentAdmission,
  attachReference,
  INLINE_ONLY,
  type ReferenceTransport,
} from './references'

/**
 * 撞的是哪道上限就说哪道。本机项目里没有「按 id 发」那一档——画布上的图也只能内联——
 * 两道上限拦的是同一批图，对用户就只有「一轮最多带 N 张」这一句；云项目里圈选的图按 id 发、
 * 不占内联名额，内联那道才需要单独说清楚。文案按调用时取：切语言之后新出的提示要跟着换。
 */
export function referenceLimitMessage(
  refusal: ReferenceRefusal,
  transport: ReferenceTransport,
): string {
  if (!transport.cloud && !attachmentUploadsEnabled())
    return i18next.t('composer.tooManyReferences', {
      ns: 'agent',
      count: AGENT_TURN_MAX_INLINE_REFERENCES,
    })
  return refusal === 'inlineOverflow'
    ? i18next.t('composer.tooManyUploads', { ns: 'agent', count: AGENT_TURN_MAX_INLINE_REFERENCES })
    : i18next.t('composer.tooManyReferences', {
        ns: 'agent',
        count: getAttachmentLimits()?.logicalReferences ?? AGENT_TURN_MAX_REFERENCES,
      })
}

const ORIGINAL_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

/**
 * 带 EXIF 方向（手机竖拍）的 JPEG 原件：浏览器按方向转正了显示、选区也画在转正后的图上，
 * 原字节却还是没转的——服务端会拒收这种图的选区。这里按原尺寸转正后重新编码，不缩小。
 */
async function uprightOriginal(file: File): Promise<Blob> {
  if (file.type !== 'image/jpeg') return file
  if (jpegOrientation(await file.arrayBuffer()) === 1) return file
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('media_unsupported_image')
    context.drawImage(bitmap, 0, 0)
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.95),
    )
    if (!blob) throw new Error('media_unsupported_image')
    return blob
  } finally {
    bitmap.close()
  }
}

function fileStem(name: string): string {
  const stem = name.replace(/\.[^.]+$/, '').trim()
  return (stem || name).slice(0, 60)
}

/**
 * 拖进来 / 粘贴 / 选出来的图片文件 → 参考图。id 现造：它不是画布对象也不是素材，
 * 模型改图时靠它指认这一张。先按传输预算预处理；文件、拖拽、粘贴与兼容内联入口共用同一条串行处理链。
 */
export function filesToReferences(
  files: readonly File[],
): AgentReference[] | Promise<AgentReference[]> {
  const limits = getAttachmentLimits()
  if (attachmentUploadsEnabled() && limits) {
    return files.map((file) => ({
      id: `file_${crypto.randomUUID()}`,
      dataUrl: registerLocalAttachmentSource(file, limits.imageBytes, limits.imagePixels),
      name: fileStem(file.name),
    }))
  }
  // 附件通道关着、但能按普通云媒体上传：原件原样留着（局部改图要按原图像素出图），
  // 超过单张上限的在输入框里就标出来、拦住发送，不缩小了再悄悄发。
  const keepOriginal = mediaFallbackEnabled()
  return (async () => {
    const sources: string[] = []
    for (const file of files) {
      if (keepOriginal && ORIGINAL_TYPES.has(file.type)) {
        if (file.size > IMAGE_PREPROCESSING.maxInputBytes)
          throw new Error('attachment_input_too_large')
        const upright = await uprightOriginal(file)
        if (upright.size > IMAGE_PREPROCESSING.maxInputBytes)
          throw new Error('attachment_input_too_large')
        sources.push(await blobDataUrl(upright))
        continue
      }
      const image = await preprocessImageFile(file)
      sources.push(await blobDataUrl(new Blob([image.data], { type: image.contentType })))
    }
    return files.map((file, at) => ({
      id: `file_${crypto.randomUUID()}`,
      dataUrl: sources[at]!,
      name: fileStem(file.name),
    }))
  })()
}

/**
 * 素材 → 草稿。组里全部视角按序附加为参考图（按 `imageId` 去重，已在条里的复用原序号），
 * 提示词里只插一个指向封面的引用——一条素材在提示词里就是一个胶囊。图可能还没下到本机，
 * 先取回来；缺任何视角都拒绝整组并提示，不能悄悄缩减用户选择的范围。
 * 引用的 id 用素材的 `imageId`：同一张图从画布进来还是从素材库进来都是同一条引用。
 */
export async function attachAssetToDraft(
  draft: AgentDraft,
  assetId: string,
  start: number,
  cursor: number,
  transport: ReferenceTransport = INLINE_ONLY,
): Promise<AttachedReference | null> {
  const asset = useLibraryStore.getState().assets.find((one) => one.id === assetId)
  if (!asset) return null

  const views = (await assetViewImages(asset)).map((image) => ({ ...image, name: asset.name }))
  const available = new Set(views.map((view) => view.id))
  if (asset.views.some((view) => !available.has(view.imageId))) {
    useStore
      .getState()
      .showToast(i18next.t('composer.assetViewsUnavailable', { ns: 'agent' }), 'error')
    return null
  }
  const [cover, ...rest] = views
  if (!cover) return null

  // 读素材库工具按「最近用过」排序，不记这一笔它就永远看不见智能体这边的使用。
  void useLibraryStore.getState().noteAssetUsed(asset.id)
  return attachReference(draft, cover, start, cursor, transport, rest)
}

/**
 * 附到草稿末尾；这一把整组放不下就一张都不附，并提示一次。拖进来的文件、素材只能内联字节，
 * 受内联那道上限管；已经在草稿里、会按 id 发的圈选图不占这个名额（见 `agentAdmission`）。
 */
export function attachReferences(
  draft: AgentDraft,
  added: readonly AgentReference[],
  transport: ReferenceTransport = INLINE_ONLY,
): AgentDraft {
  const attached = admitReferences(draft, added, agentAdmission(transport))
  if (attached.ok) return attached.draft
  useStore.getState().showToast(referenceLimitMessage(attached.reason, transport), 'error')
  return draft
}

/**
 * 输入框登记的「收文件」入口。对话区整块都是落点，但草稿只归输入框管，
 * 面板把拖进来的文件从这里递过去。
 */
let attach: ((files: File[]) => void) | null = null

export function setAgentComposerAttach(next: ((files: File[]) => void) | null): void {
  attach = next
}

export function attachFilesToComposer(files: File[]): boolean {
  if (!attach) return false
  attach(files)
  return true
}

/**
 * 已有身份的图（对话里的产物）直接成为参考图：不包成文件，也就不会被当成新上传。
 * 同一个 id 已在草稿里时复用原序号。
 */
let attachKnown: ((references: AgentReference[]) => void) | null = null

export function setAgentComposerReferences(
  next: ((references: AgentReference[]) => void) | null,
): void {
  attachKnown = next
}

export function attachReferencesToComposer(references: AgentReference[]): boolean {
  if (!attachKnown) return false
  attachKnown(references)
  return true
}
