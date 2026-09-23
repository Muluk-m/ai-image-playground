import { i18next } from '../../../i18n'
import { clientProfileToApiProfile, getActiveApiProfile } from '../../../lib/apiProfiles'
import { modelSupportsNativeMask } from '../../../lib/channels/profileSelectors'
import { getPublicChannels } from '../../../lib/channels/publicChannels'
import { resolveMediaSource } from '../../../lib/cloudMedia'
import { calculateMaskWorkingSize, prepareMaskTargetDataUrl } from '../../../lib/maskPreprocess'
import { getPrivateSubmissionGuard } from '../../../lib/privateOverlay'
import { useStore } from '../../../store'
import type { AppSettings } from '../../../types'
import type { PaintEditKind } from '../inpaintStore'
import type { ImageEl } from './canvasDoc'
import { snapshotParams } from './canvasTaskRuntime'
import { type CanvasEditor, elementBounds } from './editor'
import { exportMaskDataUrl, type MaskStroke } from './inpaintMask'
import { maskedEditSizeRefusal } from './maskedEditLimits'
import { computePlaceholderTargets } from './placement'
import { launchCanvasTask } from './submitFromCanvas'

/**
 * 这张图能不能局部重绘。返回原因即不能——按钮据此置灰并说明，不做静默隐藏。
 * `settings` 由调用方传进来而不是在这里读 store：工具条只订阅了画布版本，
 * 读全局单例会让「换了模型」这件事迟到一整个画布事件。
 */
export function inpaintRefusal(
  image: ImageEl,
  dimensions: { width: number; height: number } | null,
  settings: AppSettings,
): string | null {
  const profile = getActiveApiProfile(settings)
  // 不支持原生遮罩的模型会在分发层降级成「原图 + 蓝色高亮图」的软引导（lib/api.ts），
  // 框外会漂。那不是局部重绘，不能挂在这个名字下面。
  if (!modelSupportsNativeMask(profile, getPublicChannels()))
    return i18next.t('inpaint.modelUnsupported', { ns: 'canvas' })
  if (image.video) return i18next.t('inpaint.videoUnsupported', { ns: 'canvas' })
  // 尺寸还没读出来（位图仍在解码）时先放行：真不合规会被下面的提交路径与服务端拦住。
  if (!dimensions) return null
  const working = calculateMaskWorkingSize(dimensions.width, dimensions.height)
  return maskedEditSizeRefusal(working.width, working.height)
}

/**
 * 擦除发给模型的指令。**这段中文是数据不是文案**，不进语料、不随界面语言变（见 apps/web/CLAUDE.md）。
 * 擦除在协议上就是一次遮罩重绘，只是「改成什么」由我们替用户写死：把圈住的东西抹掉。
 */
const ERASE_INSTRUCTION =
  '移除选中区域内的全部内容，用与四周完全连续的背景自然填补，' +
  '不要留下任何残影、轮廓、阴影或模糊痕迹；未选中的区域保持原样。'

export interface InpaintSubmission {
  readonly imageId: string
  readonly kind: PaintEditKind
  readonly strokes: readonly MaskStroke[]
  readonly prompt: string
  /** 面板里附的参考图（「替换成这个」这类用法）。跟在主图后面当第二张输入图。 */
  readonly referenceDataUrl?: string
}

/**
 * 发起一次局部重绘：把源图按遮罩工作尺寸归一，用同一尺寸导出遮罩，然后交给画布任务的统一底座。
 *
 * 遮罩必须画在**归一后那张图**上而不是原始位图上——原生 mask 要求两者逐像素同尺寸，
 * 而 `lib/api.ts` 在有遮罩时刻意跳过输入图压缩，所以这里送进去多大就是多大。
 *
 * 返回是否真的起了任务（false 时已经 toast 过原因）。
 */
export async function submitCanvasInpaint(
  editor: CanvasEditor,
  input: InpaintSubmission,
): Promise<boolean> {
  const { showToast } = useStore.getState()
  const element = editor.getElement(input.imageId)
  if (element?.type !== 'image') {
    showToast(i18next.t('inpaint.sourceGone', { ns: 'canvas' }), 'error')
    return false
  }
  const profile = getActiveApiProfile(useStore.getState().settings)
  const guard = getPrivateSubmissionGuard({
    model: clientProfileToApiProfile(profile).model,
    quantity: 1,
  })
  if (guard.blocked) {
    showToast(guard.disabledReason ?? i18next.t('submit.blocked', { ns: 'canvas' }), 'error')
    return false
  }

  try {
    // 云端项目的 files 里放的是 aip-media 标识，不是位图；交给 canvas 之前必须解析。
    const source = await resolveMediaSource(editor.doc.files[element.fileId] ?? '', 'original')
    const prepared = await prepareMaskTargetDataUrl(source)
    const maskDataUrl = await exportMaskDataUrl(
      element,
      { width: prepared.width, height: prepared.height },
      input.strokes,
    )
    // 占位框就盖在源图上：结果是就地替换这一张，旁边再开一个框只会出现两个「生成中」。
    const target = { x: element.x, y: element.y, w: element.width, h: element.height }
    void launchCanvasTask(editor, {
      prompt: input.kind === 'erase' ? ERASE_INSTRUCTION : input.prompt.trim(),
      annotated: false,
      inputImageDataUrls: [
        prepared.dataUrl,
        ...(input.referenceDataUrl ? [input.referenceDataUrl] : []),
      ],
      maskDataUrl,
      editSourceId: element.id,
      editKind: input.kind,
      params: snapshotParams(),
      target,
    })
    return true
  } catch (err) {
    // 空选区与尺寸不合规都在这里收口：原样转述那句可行动的话，不糊成「生成失败」。
    showToast(err instanceof Error ? err.message : String(err), 'error')
    return false
  }
}
