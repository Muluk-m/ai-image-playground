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
 * - 尝试切到匹配 provider+model 的 profile；找不到时 toast 警告但仍应用 prompt/params
 * - 应用后关闭 Panel
 */
export function applyInspiration(item: InspirationItem) {
  const main = useStore.getState()
  const hasUnsavedInput = main.prompt.trim().length > 0

  if (hasUnsavedInput) {
    main.setConfirmDialog({
      title: '替换当前输入？',
      message: '将丢失输入框中未提交的提示词。继续将以本条灵感的提示词、参数与推荐模型覆盖。',
      confirmText: '替换并应用',
      cancelText: '取消',
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
      p.id === matched.id ? updateSelectedModel(p, item.recommendedModel, publicChannels) : p,
    )
    main.setSettings({
      profiles: nextProfiles,
      activeProfileId: matched.id,
    })
    main.showToast('已应用灵感库示例', 'success')
  } else {
    main.showToast(
      `未找到 ${item.recommendedProvider} / ${item.recommendedModel} 的可用配置，请先在设置中添加`,
      'info',
    )
  }

  inspiration.closePanel()
}
