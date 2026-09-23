import { i18next } from '../../../i18n'
import { updateSelectedModel } from '../../../lib/channels/profileSelectors'
import { getPublicChannels } from '../../../lib/channels/publicChannels'
import type { ClientProfile } from '../../../lib/channels/types'
import { API_MAX_IMAGES, MAX_INPUT_IMAGES_MESSAGE } from '../../../lib/inputImageLimit'
import { storeImageFromUrl, useStore } from '../../../store'
import type { InputImage } from '../../../types'
import { startCanvasFromComposer } from '../../agent/lib/heroHandoff'
import { useInspirationStore } from '../store'
import type { InspirationItem } from '../types'
import { matchProfile } from './matchProfile'

/**
 * 把灵感库示例应用到主 InputBar：
 * - 若主输入框已有内容，先弹 ConfirmDialog 确认覆盖
 * - 同步 setPrompt + setParams（仅覆盖 size/quality/n）
 * - 尝试切到匹配 provider+model 的 profile（同族模型可回退）；找不到时 toast 警告但仍应用 prompt/params
 * - 应用后关闭 Panel
 */
export function applyInspiration(item: InspirationItem) {
  const main = useStore.getState()
  const hasUnsavedInput = main.prompt.trim().length > 0

  if (hasUnsavedInput) {
    main.setConfirmDialog({
      title: i18next.t('apply.confirmTitle', { ns: 'inspiration' }),
      message: i18next.t('apply.confirmMessage', { ns: 'inspiration' }),
      confirmText: i18next.t('apply.confirmAction', { ns: 'inspiration' }),
      cancelText: i18next.t('action.cancel'),
      showCancel: true,
      tone: 'warning',
      action: () => void doApply(item),
    })
    return
  }

  void doApply(item)
}

async function doApply(item: InspirationItem): Promise<void> {
  const main = useStore.getState()
  const inspiration = useInspirationStore.getState()
  const references = item.referenceImages ?? []
  if (main.inputImages.length + references.length > API_MAX_IMAGES) {
    main.showToast(MAX_INPUT_IMAGES_MESSAGE, 'error')
    return
  }

  // Stage downloads before touching the composer: a bad public asset must not leave half an
  // applied prompt behind. IndexedDB may retain a successful staged image for later reuse.
  let images: InputImage[]
  try {
    images = await Promise.all(references.map(({ url }) => storeImageFromUrl(url)))
  } catch {
    main.showToast(i18next.t('apply.referenceFailed', { ns: 'inspiration' }), 'error')
    return
  }
  const current = useStore.getState()
  if (current.inputImages.length + images.length > API_MAX_IMAGES) {
    current.showToast(MAX_INPUT_IMAGES_MESSAGE, 'error')
    return
  }
  for (const image of images) current.addInputImage(image)

  if (item.kind === 'skill' && item.skill) {
    // BFF's explicit skill syntax is /skill-name, not /skill name. Handoff transfers the
    // already-staged reference IDs to the first agent turn.
    current.setPrompt(`/${item.skill} ${item.prompt}`)
    inspiration.closeDetail()
    if (!(await startCanvasFromComposer())) {
      current.showToast(i18next.t('apply.canvasFailed', { ns: 'inspiration' }), 'error')
    }
    return
  }

  current.setPrompt(item.prompt)
  current.setParams({
    size: item.params.size,
    ...(item.params.quality ? { quality: item.params.quality } : {}),
    ...(typeof item.params.n === 'number' ? { n: item.params.n } : {}),
  })

  const publicChannels = getPublicChannels()
  const matched = matchProfile({
    profiles: current.settings.profiles,
    publicChannels,
    activeProfileId: current.settings.activeProfileId,
    provider: item.recommendedProvider,
    model: item.recommendedModel,
  })

  if (matched) {
    const nextProfiles: ClientProfile[] = current.settings.profiles.map((p) =>
      p.id === matched.profile.id ? updateSelectedModel(p, matched.model, publicChannels) : p,
    )
    current.setSettings({
      profiles: nextProfiles,
      activeProfileId: matched.profile.id,
    })
    current.showToast(i18next.t('apply.succeeded', { ns: 'inspiration' }), 'success')
  } else {
    current.showToast(
      i18next.t('apply.noProfile', {
        ns: 'inspiration',
        provider: item.recommendedProvider,
        model: item.recommendedModel,
      }),
      'info',
    )
  }
  inspiration.closeDetail()
  current.setAppMode('image')
}
