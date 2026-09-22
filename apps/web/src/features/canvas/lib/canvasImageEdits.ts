import { i18next } from '../../../i18n'
import { clientProfileToApiProfile, getActiveApiProfile } from '../../../lib/apiProfiles'
import { modelSupportsNativeMask } from '../../../lib/channels/profileSelectors'
import { getPublicChannels } from '../../../lib/channels/publicChannels'
import { resolveMediaSource } from '../../../lib/cloudMedia'
import { getPrivateSubmissionGuard } from '../../../lib/privateOverlay'
import { useStore } from '../../../store'
import type { AppSettings } from '../../../types'
import type { EditRect } from '../rectEditStore'
import type { ImageEl } from './canvasDoc'
import { getCanvasTask } from './canvasTaskRuntime'
import { type CanvasEditor, elementBounds } from './editor'
import { buildOutpaintInputs, cropBitmap, localToPage, rectPixelSize } from './imageRectEdit'
import { maskedEditSizeRefusal } from './maskedEditLimits'
import { computePlaceholderTargets } from './placement'
import { decodeRecipe, rebuildSpecFromRecipe, recipeSourcesPresent } from './regenRecipe'
import { launchCanvasTask } from './submitFromCanvas'

/** 画布上已有图片的二次加工：裁切（纯本地）、扩图（走遮罩链路）、重新生成（原样再发一次）。 */

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
  const { showToast, settings } = useStore.getState()
  const blocked = submissionBlocked(settings)
  if (blocked) {
    showToast(blocked, 'error')
    return false
  }
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
    void launchCanvasTask(editor, {
      // 扩图没有「改什么」，只有「接着画」。用户不写字也能发，所以给一句默认指令。
      prompt: prompt.trim() || OUTPAINT_DEFAULT_INSTRUCTION,
      annotated: false,
      inputImageDataUrls: [inputs.source],
      maskDataUrl: inputs.mask,
      editSourceId: image.id,
      editKind: 'outpaint',
      params: { ...useStore.getState().params, n: 1 },
      recipe: {
        v: 1,
        kind: 'outpaint',
        prompt: prompt.trim() || OUTPAINT_DEFAULT_INSTRUCTION,
        annotated: false,
        params: { ...useStore.getState().params, n: 1 },
        entries: [{ imageId: image.id, graphicIds: [] }],
        rect,
      },
      target,
    })
    return true
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), 'error')
    return false
  }
}

// ===== 重新生成 =====

/**
 * 能不能再出一张。两条路，按保真度排：
 * 1. 同一次打开里，内存运行态还留着那次提交的原始输入 → 逐字节重放。
 * 2. 刷新之后运行态空了，改读随画布持久化的**配方**（用了哪些元素、什么参数、涂了哪几笔），
 *    按当前画布把输入重新造一遍。元素被删了、或者当时附过本地上传的参考图，就重出不了。
 */
export function regenerateRefusal(
  editor: CanvasEditor,
  image: ImageEl,
  settings: AppSettings,
): string | null {
  const blocked = submissionBlocked(settings)
  if (blocked) return blocked
  if (image.meta?.taskId && getCanvasTask(image.meta.taskId)) return null
  const recipe = decodeRecipe(image.meta?.regen)
  if (!recipe || recipe.hadUpload) return i18next.t('regenerate.unavailable', { ns: 'canvas' })
  if (!recipeSourcesPresent(editor, recipe))
    return i18next.t('regenerate.sourceGone', { ns: 'canvas' })
  return null
}

/** 再发一次。结果对二次加工是就地替换源图，对普通生成是落在旁边的空位。 */
export async function regenerateCanvasImage(editor: CanvasEditor, image: ImageEl): Promise<void> {
  const { showToast } = useStore.getState()
  const retained = image.meta?.taskId ? getCanvasTask(image.meta.taskId) : undefined
  try {
    const spec = retained ?? (await rebuiltSpec(editor, image))
    const anchor = spec.editSourceId
      ? { x: image.x, y: image.y, w: image.width, h: image.height }
      : computePlaceholderTargets(editor, elementBounds(image), 1)[0]
    if (!anchor) return
    void launchCanvasTask(editor, { ...spec, target: anchor })
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err), 'error')
  }
}

async function rebuiltSpec(editor: CanvasEditor, image: ImageEl) {
  const recipe = decodeRecipe(image.meta?.regen)
  if (!recipe || recipe.hadUpload)
    throw new Error(i18next.t('regenerate.unavailable', { ns: 'canvas' }))
  return await rebuildSpecFromRecipe(editor, recipe)
}
