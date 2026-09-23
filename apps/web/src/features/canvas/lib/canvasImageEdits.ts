import { i18next } from '../../../i18n'
import { clientProfileToApiProfile, getActiveApiProfile } from '../../../lib/apiProfiles'
import {
  modelSupportsEdit,
  modelSupportsNativeMask,
  NO_EDIT_SUPPORT_MESSAGE,
} from '../../../lib/channels/profileSelectors'
import { getPublicChannels } from '../../../lib/channels/publicChannels'
import { resolveMediaSource } from '../../../lib/cloudMedia'
import { getPrivateSubmissionGuard } from '../../../lib/privateOverlay'
import { calculateImageSize } from '../../../lib/size'
import { useStore } from '../../../store'
import type { AppSettings } from '../../../types'
import type { EditRect } from '../rectEditStore'
import type { ImageEl } from './canvasDoc'
import { type CanvasEditor, elementBounds } from './editor'
import { buildOutpaintInputs, cropBitmap, localToPage, rectPixelSize } from './imageRectEdit'
import { maskedEditSizeRefusal } from './maskedEditLimits'
import { computePlaceholderTargets } from './placement'
import { launchCanvasTask } from './submitFromCanvas'

/**
 * 画布上已有图片的二次加工：裁切（纯本地）、抠图（绿幕 + 本地去背）、
 * 扩图（走遮罩链路）、按一句话整图编辑。
 */

/**
 * 用户没写描述时扩图发给模型的那句。**这段中文是数据不是文案**，不进语料、
 * 不随界面语言变（见 apps/web/CLAUDE.md「这些中文不要翻」）。
 */
const OUTPAINT_DEFAULT_INSTRUCTION =
  '自然延伸原图的画面内容、光线、透视与构图，让新增区域与已有部分无缝衔接；' +
  '不要改动原有区域，也不要添加与原图无关的新主体。'

function submissionBlocked(settings: AppSettings): string | null {
  const guard = getPrivateSubmissionGuard({
    model: clientProfileToApiProfile(getActiveApiProfile(settings)).model,
    quantity: 1,
  })
  if (!guard.blocked) return null
  return guard.disabledReason ?? i18next.t('submit.blocked', { ns: 'canvas' })
}

// ===== 裁切 =====

/**
 * 按编辑框裁掉画布上那张图：位图重写、元素的位置与显示尺寸一起跟上。
 * 位置要按**旋转后**的局部原点算，否则转过的图一裁就跳走。
 */
export async function applyCanvasCrop(
  editor: CanvasEditor,
  image: ImageEl,
  rect: EditRect,
  natural: { width: number; height: number },
): Promise<boolean> {
  const { showToast } = useStore.getState()
  try {
    const source = await resolveMediaSource(editor.doc.files[image.fileId] ?? '', 'original')
    const cropped = await cropBitmap(source, rect, image, natural)
    const size = rectPixelSize(rect, image, natural)
    const origin = localToPage(image, { x: rect.x, y: rect.y })
    editor.doc.replaceImageBitmap(image.id, cropped, {
      x: origin.x,
      y: origin.y,
      width: rect.w,
      height: rect.h,
      naturalWidth: size.width,
      naturalHeight: size.height,
    })
    return true
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), 'error')
    return false
  }
}

// ===== 抠图 =====

/**
 * 抠图发给模型的那句。**这段中文是数据不是文案**，不进语料、不随界面语言变。
 *
 * gpt-image 系列不产出 alpha 通道，也没有分割能力：直接说「去掉背景」拿回来的是一张
 * 背景画成白色的**重绘图**，主体会被一起重画。所以这里走既有的绿幕路子——让它只换背景、
 * 主体逐像素保留，回来之后在本地把那块纯色键掉（`removeKeyedBackgroundFromDataUrl`），
 * 透明边缘由本地算法给。代价是主体本身仍可能被模型轻微重绘，这是这条上游能做到的上限。
 */
const CUTOUT_INSTRUCTION =
  '只替换背景，主体保持逐像素不变：不要重画、不要改动主体的轮廓、颜色、细节、姿态与位置。' +
  '把主体之外的全部区域换成纯绿色 #00FF00 的纯色背景，不要渐变、阴影、地面、倒影、纹理或光照变化；' +
  '若主体本身含有绿色/青色/荧光绿，改用纯品红 #FF00FF。' +
  '主体的轮廓、描边、辉光、反射与阴影里都不得出现所选的那个纯色。'

/** 能不能抠图。与「参考图」同一道闸：模型接不住输入图就谈不上在原图上换背景。 */
export function cutoutRefusal(image: ImageEl, settings: AppSettings): string | null {
  if (image.video) return i18next.t('cutout.videoUnsupported', { ns: 'canvas' })
  if (!modelSupportsEdit(getActiveApiProfile(settings), getPublicChannels()))
    return NO_EDIT_SUPPORT_MESSAGE
  return null
}

/**
 * 发起一次抠图：整图重画一遍、不带遮罩，结果就地替换源图。
 * 输出强制 png 且不压缩——键掉背景之后要存的是带 alpha 的图，jpeg / webp 有损会把边缘糊掉。
 */
export async function submitCanvasCutout(editor: CanvasEditor, image: ImageEl): Promise<boolean> {
  const { showToast } = useStore.getState()
  try {
    const source = await resolveMediaSource(editor.doc.files[image.fileId] ?? '', 'original')
    const params = {
      ...useStore.getState().params,
      n: 1,
      output_format: 'png' as const,
      output_compression: null,
    }
    // 占位框盖在源图上：抠完是同一张图的另一版，不该在旁边多出一张。
    const target = { x: image.x, y: image.y, w: image.width, h: image.height }
    const started = launchCanvasTask(editor, {
      prompt: CUTOUT_INSTRUCTION,
      annotated: false,
      inputImageDataUrls: [source],
      editSourceId: image.id,
      editKind: 'cutout',
      params,
      target,
    })
    return started
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), 'error')
    return false
  }
}

// ===== 扩图 =====

/** 能不能扩图。与局部重绘同一道闸：没有原生遮罩就只是整图重画，不算扩图。 */
export function outpaintRefusal(image: ImageEl, settings: AppSettings): string | null {
  if (!modelSupportsNativeMask(getActiveApiProfile(settings), getPublicChannels()))
    return i18next.t('inpaint.modelUnsupported', { ns: 'canvas' })
  if (image.video) return i18next.t('inpaint.videoUnsupported', { ns: 'canvas' })
  return null
}

/** 当前这个编辑框扩出来的尺寸合不合规。拖动时实时调用，超了就把「扩图」按钮说清楚。 */
export function outpaintRectRefusal(
  image: ImageEl,
  rect: EditRect,
  natural: { width: number; height: number } | null,
): string | null {
  if (!natural) return null
  if (rect.w <= image.width && rect.h <= image.height)
    return i18next.t('outpaint.dragFirst', { ns: 'canvas' })
  const size = rectPixelSize(rect, image, natural)
  return maskedEditSizeRefusal(size.width, size.height)
}

/**
 * 发起一次扩图：原图贴进放大后的画布，新增的边在遮罩里是透明的（交给模型），
 * 原图那块不透明（保留）。这样扩图就是遮罩重绘的一个特例，不需要新上游。
 */
export async function submitCanvasOutpaint(
  editor: CanvasEditor,
  image: ImageEl,
  rect: EditRect,
  natural: { width: number; height: number },
  prompt: string,
): Promise<boolean> {
  const { showToast } = useStore.getState()
  try {
    const original = await resolveMediaSource(editor.doc.files[image.fileId] ?? '', 'original')
    const inputs = await buildOutpaintInputs(original, rect, image, natural)
    const refusal = maskedEditSizeRefusal(inputs.width, inputs.height)
    if (refusal) {
      showToast(refusal, 'error')
      return false
    }
    // 占位框就是那个扩出来的框：结果替换掉源图本身，几何按它来，所以框在哪结果就在哪。
    const origin = localToPage(image, { x: rect.x, y: rect.y })
    const target = { x: origin.x, y: origin.y, w: rect.w, h: rect.h }
    const started = launchCanvasTask(editor, {
      // 扩图没有「改什么」，只有「接着画」。用户不写字也能发，所以给一句默认指令。
      prompt: prompt.trim() || OUTPAINT_DEFAULT_INSTRUCTION,
      annotated: false,
      inputImageDataUrls: [inputs.source],
      maskDataUrl: inputs.mask,
      editSourceId: image.id,
      editKind: 'outpaint',
      params: { ...useStore.getState().params, n: 1 },
      target,
    })
    return started
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), 'error')
    return false
  }
}

// ===== 编辑图片 =====

/** 能不能整图编辑：模型接不住输入图就谈不上在原图上改。 */
export function imageEditRefusal(image: ImageEl, settings: AppSettings): string | null {
  const blocked = submissionBlocked(settings)
  if (blocked) return blocked
  if (image.video) return i18next.t('imageEdit.videoUnsupported', { ns: 'canvas' })
  if (!modelSupportsEdit(getActiveApiProfile(settings), getPublicChannels()))
    return NO_EDIT_SUPPORT_MESSAGE
  return null
}

/**
 * 按一句话整图改这一张：不带遮罩，改完就地替换源图。
 * 与局部重绘的区别只有「改哪儿」——那个圈了区域，这个整张交给模型。
 */
export async function submitCanvasImageEdit(
  editor: CanvasEditor,
  image: ImageEl,
  prompt: string,
): Promise<boolean> {
  const { showToast } = useStore.getState()
  const requirement = prompt.trim()
  if (!requirement) return false
  try {
    const source = await resolveMediaSource(editor.doc.files[image.fileId] ?? '', 'original')
    // 占位框盖在源图上：改的是这一张，不该在旁边多出一张。
    const started = launchCanvasTask(editor, {
      prompt: requirement,
      annotated: false,
      inputImageDataUrls: [source],
      editSourceId: image.id,
      editKind: 'edit',
      params: { ...useStore.getState().params, n: 1 },
      target: { x: image.x, y: image.y, w: image.width, h: image.height },
    })
    return started
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), 'error')
    return false
  }
}

// ===== 调整尺寸 =====

/**
 * 「调整尺寸」给的那几档比例。顺序即菜单顺序；`key` 是文案 key 的那一段——
 * i18next 把冒号当命名空间分隔符，比例本身不能直接进 key。
 */
export const RESIZE_RATIOS = [
  { ratio: '1:1', key: 'square' },
  { ratio: '3:4', key: 'portrait' },
  { ratio: '9:16', key: 'story' },
  { ratio: '4:3', key: 'landscape' },
  { ratio: '16:9', key: 'wide' },
] as const
export type ResizeRatio = (typeof RESIZE_RATIOS)[number]['ratio']

/**
 * 换比例发给模型的那句。**这段中文是数据不是文案**，不进语料、不随界面语言变。
 *
 * 这不是裁切：模型按新画幅重新构图，缺的边自然补、多的边自然收。要像素级不动画面
 * 请用裁切。
 */
function resizeInstruction(ratio: ResizeRatio): string {
  return (
    `把这张图重新构图为 ${ratio} 的画幅：主体、风格、光线与色彩保持一致，` +
    '需要补出来的区域按原图环境自然延伸，需要收掉的区域顺势裁去；' +
    '不要拉伸或挤压画面，也不要添加与原图无关的新主体。'
  )
}

/** 能不能换比例：与整图编辑同一道闸——都是拿原图当输入重画一张。 */
export function resizeRefusal(image: ImageEl, settings: AppSettings): string | null {
  return imageEditRefusal(image, settings)
}

/**
 * 按选中的比例重出这一张。结果落在**旁边的空位**而不是原地：换画幅是另一版素材，
 * 用户多半要拿它和原图比着挑，就地替换会把原图吃掉。
 */
export async function submitCanvasResize(
  editor: CanvasEditor,
  image: ImageEl,
  ratio: ResizeRatio,
): Promise<boolean> {
  const { showToast } = useStore.getState()
  try {
    const source = await resolveMediaSource(editor.doc.files[image.fileId] ?? '', 'original')
    const params = useStore.getState().params
    const [target] = computePlaceholderTargets(editor, elementBounds(image), 1)
    if (!target) return false
    const started = launchCanvasTask(editor, {
      prompt: resizeInstruction(ratio),
      annotated: false,
      inputImageDataUrls: [source],
      params: {
        ...params,
        n: 1,
        // OpenAI 路径认 size 字符串，Gemini 认比例本身：两个都给，各取各的。
        // 算不出合规尺寸（理论上这几档都算得出）就退回 auto，不拿空串去发。
        size: calculateImageSize('1K', ratio) ?? 'auto',
        gemini_aspect_ratio: ratio,
      },
      target,
    })
    return started
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), 'error')
    return false
  }
}
