import { create } from 'zustand'
import { i18next } from '../../../i18n'
import { getProfileModels, updateSelectedModel } from '../../../lib/channels/profileSelectors'
import { getPublicChannels } from '../../../lib/channels/publicChannels'
import { useStore } from '../../../store'
import type { LookItem } from './looks'

interface ActiveLookState {
  /** 生成模式输入框顶部那颗模板胶囊；发送或手动摘掉即清空。 */
  look: LookItem | null
  set: (look: LookItem | null) => void
}

export const useActiveLook = create<ActiveLookState>((set) => ({
  look: null,
  set: (look) => set({ look }),
}))

/** 当前部署里所有可选的图片模型 id：判断模板钉死的模型还在不在。 */
export function availableImageModels(): ReadonlySet<string> {
  const publicChannels = getPublicChannels()
  const { settings } = useStore.getState()
  return new Set(settings.profiles.flatMap((profile) => getProfileModels(profile, publicChannels)))
}

/**
 * 生成模式点了模板 chip：挂上胶囊，把模型与尺寸切到模板钉死的那套。
 * 模型在哪个 profile 下就切到哪个 profile；找不到就只挂胶囊，提交时按「需重新调试」拦。
 */
export function applyLookToComposer(look: LookItem): void {
  const store = useStore.getState()
  const publicChannels = getPublicChannels()
  const profile = store.settings.profiles.find((one) =>
    getProfileModels(one, publicChannels).includes(look.model),
  )
  if (profile) {
    store.setSettings({
      profiles: store.settings.profiles.map((one) =>
        one.id === profile.id ? updateSelectedModel(one, look.model, publicChannels) : one,
      ),
      activeProfileId: profile.id,
    })
  }
  store.setParams({ size: look.size })
  useActiveLook.getState().set(look)
  store.showToast(
    i18next.t('look.applied', { ns: 'library', model: look.model, size: look.size }),
    'info',
  )
}
