/**
 * 用户设置：从持久化 blob 里划出的、可跨设备携带的那一份文档。整份存取、整份 LWW。
 * 密钥类数据（BYOK profile、customProviders、providerOrder、profileModelCache）与本机数据
 * （草稿、槽位值、任务记录、商品图任务、画布）都不在这里，加字段前先对照 CONTEXT.md。
 */
import { APP_MODES, type AppMode, useStore } from '../../store'
import { DEFAULT_PARAMS, type TaskParams } from '../../types'
import { getActiveApiProfile, normalizeSettings } from '../apiProfiles'
import { updateSelectedModel } from '../channels/profileSelectors'
import { getPublicChannels } from '../channels/publicChannels'

// type 而非 interface：协议侧的 document 是 Record<string, unknown>，只有 type 有隐式索引签名。
export type UserSettingsDocument = {
  clearInputAfterSubmit: boolean
  persistInputOnRestart: boolean
  reuseTaskApiProfileTemporarily: boolean
  alwaysShowRetryButton: boolean
  enterSubmit: boolean
  params: TaskParams
  appMode: AppMode
  /** 选中的是 BYOK profile 时为 null：那是本机的事，不跨设备。 */
  builtinChannel: { channelId: string; modelId: string } | null
  pinnedInspirationIds: string[]
  inspirationCoachDismissed: boolean
  libraryCoachDismissed: boolean
  libraryPanelOpened: boolean
  assetHintShown: boolean
}

export function readUserSettingsDocument(): UserSettingsDocument {
  const state = useStore.getState()
  const settings = normalizeSettings(state.settings)
  const active = getActiveApiProfile(settings)
  return {
    clearInputAfterSubmit: settings.clearInputAfterSubmit,
    persistInputOnRestart: settings.persistInputOnRestart,
    reuseTaskApiProfileTemporarily: settings.reuseTaskApiProfileTemporarily,
    alwaysShowRetryButton: settings.alwaysShowRetryButton,
    enterSubmit: settings.enterSubmit,
    params: { ...state.params },
    appMode: state.appMode,
    builtinChannel:
      active.source === 'builtin-edge'
        ? { channelId: active.channelId, modelId: active.selectedModelId }
        : null,
    pinnedInspirationIds: [...state.pinnedInspirationIds],
    inspirationCoachDismissed: state.inspirationCoachDismissed,
    libraryCoachDismissed: state.libraryCoachDismissed,
    libraryPanelOpened: state.libraryPanelOpened,
    assetHintShown: state.assetHintShown,
  }
}

/** 服务端回传的文档由另一台设备写下，版本可能更旧或更新，逐字段守卫。 */
export function applyUserSettingsDocument(document: unknown): void {
  if (!isRecord(document)) return
  const state = useStore.getState()
  const settings = normalizeSettings(state.settings)

  state.setSettings({
    clearInputAfterSubmit: boolean(document.clearInputAfterSubmit, settings.clearInputAfterSubmit),
    persistInputOnRestart: boolean(document.persistInputOnRestart, settings.persistInputOnRestart),
    reuseTaskApiProfileTemporarily: boolean(
      document.reuseTaskApiProfileTemporarily,
      settings.reuseTaskApiProfileTemporarily,
    ),
    alwaysShowRetryButton: boolean(document.alwaysShowRetryButton, settings.alwaysShowRetryButton),
    enterSubmit: boolean(document.enterSubmit, settings.enterSubmit),
    ...selectedBuiltinChannel(document.builtinChannel, settings),
  })

  if (isRecord(document.params)) {
    state.setParams({ ...DEFAULT_PARAMS, ...(document.params as Partial<TaskParams>) })
  }
  if (APP_MODES.includes(document.appMode as AppMode)) state.setAppMode(document.appMode as AppMode)

  useStore.setState({
    pinnedInspirationIds: Array.isArray(document.pinnedInspirationIds)
      ? document.pinnedInspirationIds.filter((id): id is string => typeof id === 'string')
      : state.pinnedInspirationIds,
    inspirationCoachDismissed: boolean(
      document.inspirationCoachDismissed,
      state.inspirationCoachDismissed,
    ),
    libraryCoachDismissed: boolean(document.libraryCoachDismissed, state.libraryCoachDismissed),
    libraryPanelOpened: boolean(document.libraryPanelOpened, state.libraryPanelOpened),
    assetHintShown: boolean(document.assetHintShown, state.assetHintShown),
  })
}

type AppSettings = ReturnType<typeof normalizeSettings>

/** 本机没有这个 channel 时保持原选择，否则会把用户钉在一个不存在的 profile 上。 */
function selectedBuiltinChannel(
  value: unknown,
  settings: AppSettings,
): Partial<AppSettings> | undefined {
  if (
    !isRecord(value) ||
    typeof value.channelId !== 'string' ||
    typeof value.modelId !== 'string'
  ) {
    return undefined
  }
  const target = settings.profiles.find(
    (profile) => profile.source === 'builtin-edge' && profile.channelId === value.channelId,
  )
  if (!target) return undefined
  return {
    activeProfileId: target.id,
    profiles: settings.profiles.map((profile) =>
      profile.id === target.id
        ? updateSelectedModel(profile, value.modelId as string, getPublicChannels())
        : profile,
    ),
  }
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
