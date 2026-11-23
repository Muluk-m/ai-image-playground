import { i18next } from '../../i18n'
import { getActiveApiProfile } from '../../lib/apiProfiles'
import {
  referenceAdmission,
  referenceRefusal,
  referenceRefusalMessage,
  referenceTally,
} from '../../lib/referenceDraft'
import { storeImageFromFile, useStore } from '../../store'
import type { InputImage } from '../../types'
import type { DeliverableImage } from '../toolbox/lib/deliver'

/**
 * 可取消的「放入创作输入框」交付：在每一步异步写盘前后及写入 store / 切换视图前检查 AbortSignal，
 * 避免用户在导出过程中切换工具或离开页面后仍被旧任务强行跳回创作页或写入过期附件。
 */
export async function deliverResizedToComposer(
  images: readonly DeliverableImage[],
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  if (images.length === 0) return
  const { inputImages, settings, showToast } = useStore.getState()
  const admission = referenceAdmission(getActiveApiProfile(settings))
  const refusal = referenceRefusal(
    referenceTally(inputImages, admission),
    { total: images.length },
    admission,
  )
  if (refusal) {
    showToast(referenceRefusalMessage(refusal), 'error')
    return
  }
  const stored: InputImage[] = []
  for (const image of images) {
    signal?.throwIfAborted()
    const item = await storeImageFromFile(
      new File([image.blob], image.name, { type: image.blob.type }),
    )
    signal?.throwIfAborted()
    stored.push(item)
  }
  signal?.throwIfAborted()
  const latest = useStore.getState()
  if (!latest.attachInputImages(stored, admission)) return
  latest.setAppMode('image')
  latest.showToast(i18next.t('composer.sent', { ns: 'toolbox', count: images.length }), 'success')
}
