import { i18next } from '../../../i18n'
import { getActiveApiProfile } from '../../../lib/apiProfiles'
import { updateSelectedModel } from '../../../lib/channels/profileSelectors'
import { getPublicChannels } from '../../../lib/channels/publicChannels'
import type { ClientProfile } from '../../../lib/channels/types'
import { API_MAX_IMAGES } from '../../../lib/inputImageLimit'
import { referenceAdmission } from '../../../lib/referenceDraft'
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

  if (item.kind === 'skill' && item.skill) {
    // 这几张图是交给画布第一轮的，改图能力归那一轮的模型管，不看生图模型认不认参考图。
    if (!current.attachInputImages(images, { limit: API_MAX_IMAGES, supportsEdit: true })) return
    // BFF's explicit skill syntax is /skill-name, not /skill name. Handoff transfers the
    // already-staged reference IDs to the first agent turn.
    current.setPrompt(`/${item.skill} ${item.prompt}`)
    inspiration.closeDetail()
    if (!(await startCanvasFromComposer())) {
      current.showToast(i18next.t('apply.canvasFailed', { ns: 'inspiration' }), 'error')
    }
    return
  }

  const publicChannels = getPublicChannels()
  const matched = matchProfile({
    profiles: current.settings.profiles,
    publicChannels,
    activeProfileId: current.settings.activeProfileId,
    provider: item.recommendedProvider,
    model: item.recommendedModel,
  })
  // 「玩同款」先换模型再附图，所以准入按换上之后那个模型算；换不到就按当前这个。
  // 判定用的是还没写下去的那份 profile：附不上就整条不套用，模型也不该已经被换掉。
  const nextProfile = matched
    ? updateSelectedModel(matched.profile, matched.model, publicChannels)
    : getActiveApiProfile(current.settings)
  if (!current.attachInputImages(images, referenceAdmission(nextProfile))) return

  if (matched) {
    const nextProfiles: ClientProfile[] = current.settings.profiles.map((p) =>
      p.id === matched.profile.id ? nextProfile : p,
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
  current.setPrompt(item.prompt)
  current.setParams({
    size: item.params.size,
    ...(item.params.quality ? { quality: item.params.quality } : {}),
    ...(typeof item.params.n === 'number' ? { n: item.params.n } : {}),
  })
  inspiration.closeDetail()
  current.setAppMode('image')
}
