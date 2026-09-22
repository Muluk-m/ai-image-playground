import { i18next } from '../../../i18n'
import { updateSelectedModel } from '../../../lib/channels/profileSelectors'
import { getPublicChannels } from '../../../lib/channels/publicChannels'
import type { ClientProfile } from '../../../lib/channels/types'
import { useStore } from '../../../store'
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
      action: () => doApply(item),
    })
    return
  }

  doApply(item)
}

function doApply(item: InspirationItem) {
  const main = useStore.getState()
  const inspiration = useInspirationStore.getState()

  main.setPrompt(item.prompt)
  main.setParams({
    size: item.params.size,
    ...(item.params.quality ? { quality: item.params.quality } : {}),
    ...(typeof item.params.n === 'number' ? { n: item.params.n } : {}),
  })

  const publicChannels = getPublicChannels()
  const matched = matchProfile({
    profiles: main.settings.profiles,
    publicChannels,
    activeProfileId: main.settings.activeProfileId,
    provider: item.recommendedProvider,
    model: item.recommendedModel,
  })

  if (matched) {
    const nextProfiles: ClientProfile[] = main.settings.profiles.map((p) =>
      p.id === matched.profile.id ? updateSelectedModel(p, matched.model, publicChannels) : p,
    )
    main.setSettings({
      profiles: nextProfiles,
      activeProfileId: matched.profile.id,
    })
    main.showToast(i18next.t('apply.succeeded', { ns: 'inspiration' }), 'success')
  } else {
    main.showToast(
      i18next.t('apply.noProfile', {
        ns: 'inspiration',
        provider: item.recommendedProvider,
        model: item.recommendedModel,
      }),
      'info',
    )
  }

  // 套用完就回创作页：提示词与参数已经写进输入框，人要看的是那里。
  inspiration.closeDetail()
  main.setAppMode('image')
}
