import { type MutableRefObject, useEffect, useRef, useState } from 'react'
import { useTranslation } from '../../i18n'
import { normalizeBaseUrl } from '../../lib/api'
import {
  type ApiProfile,
  apiProfileToClientProfile,
  clientProfileToApiProfile,
  DEFAULT_GEMINI_BASE_URL,
  DEFAULT_IMAGES_MODEL,
  DEFAULT_OPENAI_PROFILE_ID,
  DEFAULT_RESPONSES_MODEL,
  getActiveApiProfile,
  getApiProviderLabel,
  importCustomProviderSettingsFromJson,
  mergeImportedSettings,
  normalizeApiTimeout,
  normalizeCustomProviderDefinition,
  normalizeSettings,
} from '../../lib/apiProfiles'
import type { ProviderKind } from '../../lib/channels/types'
import { copyTextToClipboard, getClipboardFailureMessage } from '../../lib/clipboard'
import { isApiProxyAvailable, readClientDevProxyConfig } from '../../lib/devProxy'
import { DEFAULT_DROPDOWN_MAX_HEIGHT, getDropdownMaxHeight } from '../../lib/dropdown'
import { fetchProfileModels } from '../../lib/fetchProfileModels'
import { profileSeedNames } from '../../lib/profileSeedNames'
import { getProviderModelOptions } from '../../lib/providerModels'
import { useStore } from '../../store'
import type { AppSettings, CustomProviderDefinition } from '../../types'
import { ChevronDownIcon, CopyIcon, LinkIcon, PlusIcon, TrashIcon } from '../icons'
import ModelCombobox from '../ModelCombobox'
import Select from '../Select'
import { Switch } from '../Switch'
import ViewportTooltip from '../ViewportTooltip'
import {
  createDefaultOpenAIProfile,
  DEFAULT_BYOK_BASEURL,
  type DraftSettings,
  fromDraftSettings,
  getActiveDraftProfile,
  getDefaultModelForMode,
  getImportedProfileFromMergedSettings,
  isBuiltinDraftProfile,
  isOpenAICompatibleProvider,
  isPristineNewOpenAIProfile,
  newId,
  normalizeDraftSettings,
  switchApiProfileProvider,
  toDraftSettings,
} from './apiDraft'
import CustomProviderDialog, {
  type CustomProviderForm,
  createDefaultCustomProviderForm,
  customProviderFormToInput,
  customProviderToForm,
} from './CustomProviderDialog'
import ImportUrlDialog, {
  type CopyImportUrlOptions,
  readCopyImportUrlOptions,
  saveCopyImportUrlOptions,
} from './ImportUrlDialog'

const ADD_CUSTOM_PROVIDER_VALUE = '__add_custom_provider__'

/**
 * 表单草稿的初值。代理不可用（或不是 OpenAI 兼容）时把 apiProxy 抹平，
 * 免得界面上画着「已开代理」而实际请求并不走代理。
 */
function seedDraft(settings: AppSettings, apiProxyAvailable: boolean): DraftSettings {
  const normalized = toDraftSettings(normalizeSettings(settings))
  return {
    ...normalized,
    profiles: normalized.profiles.map((profile) => ({
      ...profile,
      apiProxy: profile.provider === 'openai' && apiProxyAvailable ? profile.apiProxy : false,
    })),
  }
}

interface ApiTabProps {
  /** 关弹窗时把正在编辑的输入框落盘：ESC 关闭不经过 blur。 */
  flushRef: MutableRefObject<(() => void) | null>
}

/** API 配置（BYOK）。没有 BYOK 能力的部署根本不渲染它。 */
export default function ApiTab({ flushRef }: ApiTabProps) {
  const { t } = useTranslation('settings')
  const { t: tCommon } = useTranslation('common')
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const showToast = useStore((s) => s.showToast)
  const profileModelCache = useStore((s) => s.profileModelCache)
  const setProfileModelCache = useStore((s) => s.setProfileModelCache)

  const apiProxyConfig = readClientDevProxyConfig()
  const apiProxyAvailable = isApiProxyAvailable(apiProxyConfig)

  const [draft, setDraft] = useState<DraftSettings>(() => seedDraft(settings, apiProxyAvailable))
  const [timeoutInput, setTimeoutInput] = useState(() =>
    String(getActiveDraftProfile(seedDraft(settings, apiProxyAvailable)).timeout),
  )
  const [refreshingModels, setRefreshingModels] = useState(false)
  const [showApiKey, setShowApiKey] = useState(false)
  const [showProfileMenu, setShowProfileMenu] = useState(false)
  const [profileMenuMaxHeight, setProfileMenuMaxHeight] = useState(DEFAULT_DROPDOWN_MAX_HEIGHT)
  const [showCustomProviderImport, setShowCustomProviderImport] = useState(false)
  const [editingCustomProviderId, setEditingCustomProviderId] = useState<string | null>(null)
  const [customProviderForm, setCustomProviderForm] = useState<CustomProviderForm>(
    createDefaultCustomProviderForm,
  )
  const [customProviderImportError, setCustomProviderImportError] = useState<string | null>(null)
  const [isImportingJson, setIsImportingJson] = useState(false)
  const [profileImportUrlTooltipVisible, setProfileImportUrlTooltipVisible] = useState(false)
  const [duplicateProfileTooltipVisible, setDuplicateProfileTooltipVisible] = useState(false)
  const [copyImportUrlProfile, setCopyImportUrlProfile] = useState<ApiProfile | null>(null)
  const [copyImportUrlOptions, setCopyImportUrlOptions] =
    useState<CopyImportUrlOptions>(readCopyImportUrlOptions)

  const profileMenuRef = useRef<HTMLDivElement>(null)
  const profileMenuTriggerRef = useRef<HTMLButtonElement>(null)
  const profileImportUrlTooltipTimerRef = useRef<number | null>(null)
  const duplicateProfileTooltipTimerRef = useRef<number | null>(null)

  const activeProfile =
    draft.profiles.find((profile) => profile.id === draft.activeProfileId) ??
    draft.profiles[0] ??
    getActiveApiProfile(draft)
  const apiProxyChecked = activeProfile.provider === 'openai' && activeProfile.apiProxy
  const apiProxyEnabled =
    apiProxyAvailable && activeProfile.provider === 'openai' && apiProxyChecked
  const activeProviderIsOpenAICompatible = isOpenAICompatibleProvider(draft, activeProfile.provider)
  const activeProviderUsesApiUrl =
    activeProviderIsOpenAICompatible || activeProfile.provider === 'gemini'
  const activeIsBuiltin = isBuiltinDraftProfile(activeProfile)
  const activeCustomProvider = draft.customProviders.find(
    (provider) => provider.id === activeProfile.provider,
  )

  // 服务商固定顺序：OpenAI 兼容、Gemini，然后是自定义服务商的创建顺序。
  const providerOptions = [
    {
      label: t('provider.createCustom'),
      value: ADD_CUSTOM_PROVIDER_VALUE,
      variant: 'action' as const,
    },
    { label: t('provider.openaiCompatible'), value: 'openai' },
    { label: 'Gemini', value: 'gemini' },
    ...draft.customProviders.map((provider) => ({
      label: provider.name,
      value: provider.id,
      actions: [
        { label: tCommon('action.edit'), onClick: () => openEditCustomProvider(provider) },
        {
          label: tCommon('action.delete'),
          variant: 'danger' as const,
          onClick: () => confirmDeleteCustomProvider(provider),
        },
      ],
    })),
  ]

  useEffect(() => {
    setTimeoutInput(String(activeProfile.timeout))
  }, [activeProfile.id, activeProfile.timeout])

  const updateProfileMenuMaxHeight = () => {
    if (!profileMenuTriggerRef.current) return
    setProfileMenuMaxHeight(getDropdownMaxHeight(profileMenuTriggerRef.current))
  }

  useEffect(() => {
    if (!showProfileMenu) return

    const handlePointerDown = (event: PointerEvent) => {
      if (profileMenuRef.current?.contains(event.target as Node)) return
      setShowProfileMenu(false)
    }
    const handleReposition = () => {
      if (!profileMenuTriggerRef.current) return
      setProfileMenuMaxHeight(getDropdownMaxHeight(profileMenuTriggerRef.current))
    }

    handleReposition()
    document.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('resize', handleReposition)
    window.addEventListener('scroll', handleReposition, true)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('resize', handleReposition)
      window.removeEventListener('scroll', handleReposition, true)
    }
  }, [showProfileMenu])

  useEffect(
    () => () => {
      if (profileImportUrlTooltipTimerRef.current != null)
        window.clearTimeout(profileImportUrlTooltipTimerRef.current)
      if (duplicateProfileTooltipTimerRef.current != null)
        window.clearTimeout(duplicateProfileTooltipTimerRef.current)
    },
    [],
  )

  const clearProfileImportUrlTooltipTimer = () => {
    if (profileImportUrlTooltipTimerRef.current != null) {
      window.clearTimeout(profileImportUrlTooltipTimerRef.current)
      profileImportUrlTooltipTimerRef.current = null
    }
  }

  const clearDuplicateProfileTooltipTimer = () => {
    if (duplicateProfileTooltipTimerRef.current != null) {
      window.clearTimeout(duplicateProfileTooltipTimerRef.current)
      duplicateProfileTooltipTimerRef.current = null
    }
  }

  const commitSettings = (nextDraft: DraftSettings) => {
    const defaultOpenAI = createDefaultOpenAIProfile()
    const normalizedProfiles: ApiProfile[] = nextDraft.profiles.map((profile) => {
      const normalizedBaseUrl =
        profile.provider === 'gemini'
          ? profile.baseUrl.trim().replace(/\/+$/, '') || DEFAULT_GEMINI_BASE_URL
          : normalizeBaseUrl(profile.baseUrl.trim() || defaultOpenAI.baseUrl)
      const defaultModel = getDefaultModelForMode(profile.apiMode)
      return {
        ...profile,
        name:
          profile.name.trim() ||
          (profile.id === DEFAULT_OPENAI_PROFILE_ID
            ? profileSeedNames().defaultProfile
            : profileSeedNames().newProfile),
        baseUrl: normalizedBaseUrl,
        model: profile.model.trim() || defaultModel,
        timeout: normalizeApiTimeout(Number(profile.timeout)),
        apiProxy: profile.provider === 'openai' && apiProxyAvailable ? profile.apiProxy : false,
        codexCli: profile.provider === 'openai' ? profile.codexCli : false,
      }
    })
    const fallbackProfile = createDefaultOpenAIProfile({ id: newId('openai') })
    const effectiveProfiles = normalizedProfiles.length ? normalizedProfiles : [fallbackProfile]
    const activeId = effectiveProfiles.some((profile) => profile.id === nextDraft.activeProfileId)
      ? nextDraft.activeProfileId
      : effectiveProfiles[0].id
    // 只写回 API 面的字段：习惯配置那一页可能刚改过，整份覆盖会把它盖回打开草稿时的旧值。
    setSettings({
      profiles: effectiveProfiles.map((profile) => apiProfileToClientProfile(profile)),
      activeProfileId: activeId,
      customProviders: nextDraft.customProviders,
    })
    setDraft(toDraftSettings(useStore.getState().settings))
  }

  const getDraftWithActiveProfilePatch = (patch: Partial<ApiProfile>) => ({
    ...draft,
    profiles: draft.profiles.map((profile) =>
      profile.id === activeProfile.id ? { ...profile, ...patch } : profile,
    ),
  })

  const updateActiveProfile = (patch: Partial<ApiProfile>, commit = false) => {
    const nextDraft = getDraftWithActiveProfilePatch(patch)
    setDraft(nextDraft)
    if (commit) commitSettings(nextDraft)
  }

  const commitActiveProfilePatch = (patch: Partial<ApiProfile>) => {
    commitSettings(getDraftWithActiveProfilePatch(patch))
  }

  const commitTimeout = () => {
    if (!activeProviderIsOpenAICompatible) return
    const nextTimeout = Number(timeoutInput)
    // 输入框里是乱码时保持上一次的值，别把用户正在改的数字悄悄换掉；
    // 空 / 0 / 负数都退回默认超时（0 会让请求在发出的瞬间被 abort）。
    const normalizedTimeout =
      timeoutInput.trim() !== '' && Number.isNaN(nextTimeout)
        ? activeProfile.timeout
        : normalizeApiTimeout(nextTimeout)
    setTimeoutInput(String(normalizedTimeout))
    updateActiveProfile({ timeout: normalizedTimeout }, true)
  }

  // 关弹窗时把草稿落盘。每次渲染重新登记，拿到的才是当下这一份闭包。
  useEffect(() => {
    flushRef.current = () => {
      const normalizedTimeout = normalizeApiTimeout(Number(timeoutInput))
      commitSettings({
        ...draft,
        profiles: activeProviderIsOpenAICompatible
          ? draft.profiles.map((profile) =>
              profile.id === activeProfile.id
                ? { ...profile, timeout: normalizedTimeout }
                : profile,
            )
          : draft.profiles,
      })
    }
    return () => {
      flushRef.current = null
    }
  })

  const updateCopyImportUrlOptions = (patch: Partial<CopyImportUrlOptions>) => {
    setCopyImportUrlOptions((previous) => {
      const next = { ...previous, ...patch, includeApiKey: false }
      saveCopyImportUrlOptions(next)
      return next
    })
  }

  const createProfileImportUrl = (profile: ApiProfile, options: CopyImportUrlOptions) => {
    const url = new URL(window.location.href)
    url.search = ''
    url.hash = ''

    if (profile.provider === 'openai') {
      const baseUrl = profile.baseUrl.trim() || DEFAULT_BYOK_BASEURL
      url.searchParams.set(
        'apiUrl',
        options.useNewApiAddress && !options.includeApiKey
          ? '{address}'
          : normalizeBaseUrl(baseUrl),
      )
      if (options.includeApiKey && profile.apiKey.trim()) {
        url.searchParams.set('apiKey', profile.apiKey.trim())
      } else if (!options.includeApiKey && options.useNewApiKey) {
        url.searchParams.set('apiKey', '{key}')
      }
      url.searchParams.set('apiMode', profile.apiMode)
      const model = profile.model.trim() || getDefaultModelForMode(profile.apiMode)
      url.searchParams.set(
        'model',
        !options.includeApiKey && options.useNewApiModel ? '{model}' : model,
      )
      if (profile.codexCli) url.searchParams.set('codexCli', 'true')

      let result = url.toString()
      if (!options.includeApiKey) {
        if (options.useNewApiAddress) result = result.replace('%7Baddress%7D', '{address}')
        if (options.useNewApiKey) result = result.replace('%7Bkey%7D', '{key}')
        if (options.useNewApiModel) result = result.replace('%7Bmodel%7D', '{model}')
      }
      return result
    }

    const provider = draft.customProviders.find((item) => item.id === profile.provider)
    const importProfile: ApiProfile = {
      ...profile,
      apiKey: options.includeApiKey ? profile.apiKey : '',
    }
    if (!options.includeApiKey) {
      if (options.useNewApiAddress) importProfile.baseUrl = '{address}'
      if (options.useNewApiKey) importProfile.apiKey = '{key}'
      if (options.useNewApiModel) importProfile.model = '{model}'
    }
    url.searchParams.set(
      'settings',
      JSON.stringify({
        customProviders: provider ? [provider] : [],
        profiles: [importProfile],
      }),
    )

    let result = url.toString()
    if (!options.includeApiKey) {
      if (options.useNewApiAddress) result = result.replace(/%7Baddress%7D/g, '{address}')
      if (options.useNewApiKey) result = result.replace(/%7Bkey%7D/g, '{key}')
      if (options.useNewApiModel) result = result.replace(/%7Bmodel%7D/g, '{model}')
    }
    return result
  }

  const copyProfileImportUrl = async (profile: ApiProfile, options: CopyImportUrlOptions) => {
    try {
      await copyTextToClipboard(createProfileImportUrl(profile, options))
      showToast(
        options.includeApiKey ? t('toast.importUrlCopiedWithKey') : t('toast.importUrlCopied'),
        'success',
      )
      setCopyImportUrlProfile(null)
    } catch (err) {
      showToast(getClipboardFailureMessage(t('toast.copyImportUrlFailed'), err), 'error')
    }
  }

  const confirmCopyProfileImportUrl = (profile: ApiProfile) => {
    setShowProfileMenu(false)
    setProfileImportUrlTooltipVisible(false)
    setCopyImportUrlProfile(profile)
    setCopyImportUrlOptions(readCopyImportUrlOptions())
  }

  const createNewProfile = () => {
    const profile = createDefaultOpenAIProfile({
      id: newId('openai'),
      name: profileSeedNames().newProfile,
    })
    commitSettings(
      normalizeDraftSettings({
        ...draft,
        profiles: [...draft.profiles, profile],
        activeProfileId: profile.id,
      }),
    )
    setShowProfileMenu(false)
  }

  const duplicateActiveProfile = () => {
    setDuplicateProfileTooltipVisible(false)
    const profile: ApiProfile = {
      ...activeProfile,
      id: newId(activeProfile.provider === 'openai' ? 'openai' : 'profile'),
      name: profileSeedNames().copyOf(activeProfile.name),
    }
    commitSettings(
      normalizeDraftSettings({
        ...draft,
        profiles: [...draft.profiles, profile],
        activeProfileId: profile.id,
      }),
    )
    setShowProfileMenu(false)
  }

  const switchProfile = (id: string) => {
    commitSettings(normalizeDraftSettings({ ...draft, activeProfileId: id }))
    setShowProfileMenu(false)
  }

  const deleteProfile = (id: string) => {
    if (draft.profiles.length <= 1) return
    const nextProfiles = draft.profiles.filter((item) => item.id !== id)
    commitSettings(
      normalizeDraftSettings({
        ...draft,
        profiles: nextProfiles,
        activeProfileId: draft.activeProfileId === id ? nextProfiles[0].id : draft.activeProfileId,
      }),
    )
  }

  const handleProviderTypeChange = (value: string | number) => {
    if (value === ADD_CUSTOM_PROVIDER_VALUE) {
      setEditingCustomProviderId(null)
      setCustomProviderForm(createDefaultCustomProviderForm())
      setShowCustomProviderImport(true)
      setCustomProviderImportError(null)
      return
    }
    updateActiveProfile(switchApiProfileProvider(activeProfile, String(value)), true)
  }

  const closeCustomProviderDialog = () => {
    setShowCustomProviderImport(false)
    setEditingCustomProviderId(null)
  }

  const updateCustomProviderForm = (patch: Partial<CustomProviderForm>) => {
    setCustomProviderForm((current) => ({ ...current, ...patch }))
    setCustomProviderImportError(null)
  }

  const buildCustomProviderFromForm = () => {
    const input = customProviderFormToInput(customProviderForm)
    const usedIds = new Set(
      draft.customProviders
        .filter((item) => item.id !== editingCustomProviderId)
        .map((item) => item.id),
    )
    const provider = normalizeCustomProviderDefinition(
      editingCustomProviderId && input && typeof input === 'object'
        ? { ...input, id: editingCustomProviderId }
        : input,
      usedIds,
    )
    if (!provider) throw new Error(t('customProvider.invalid'))
    return provider
  }

  function openEditCustomProvider(provider: CustomProviderDefinition) {
    setEditingCustomProviderId(provider.id)
    setCustomProviderForm(customProviderToForm(provider))
    setShowCustomProviderImport(true)
    setCustomProviderImportError(null)
  }

  const saveCustomProvider = () => {
    try {
      const customProvider = buildCustomProviderFromForm()
      if (editingCustomProviderId) {
        commitSettings(
          normalizeDraftSettings({
            ...draft,
            customProviders: draft.customProviders.map((provider) =>
              provider.id === editingCustomProviderId ? customProvider : provider,
            ),
          }),
        )
        closeCustomProviderDialog()
        setCustomProviderImportError(null)
        showToast(t('toast.providerUpdated'), 'success')
        return
      }

      const nextProfile = switchApiProfileProvider(activeProfile, customProvider.id)
      commitSettings(
        normalizeDraftSettings({
          ...draft,
          customProviders: [...draft.customProviders, customProvider],
          profiles: draft.profiles.map((profile) =>
            profile.id === activeProfile.id ? nextProfile : profile,
          ),
        }),
      )
      closeCustomProviderDialog()
      setCustomProviderImportError(null)
    } catch (err) {
      setCustomProviderImportError(err instanceof Error ? err.message : String(err))
    }
  }

  function confirmDeleteCustomProvider(provider: CustomProviderDefinition) {
    setConfirmDialog({
      title: t('provider.deleteTitle'),
      message: t('provider.deleteMessage', { name: provider.name }),
      action: () => deleteCustomProvider(provider),
    })
  }

  function deleteCustomProvider(provider: CustomProviderDefinition) {
    const providerId = provider.id
    commitSettings(
      normalizeDraftSettings({
        ...draft,
        customProviders: draft.customProviders.filter((item) => item.id !== providerId),
        profiles: draft.profiles.map((profile) =>
          profile.provider === providerId ? switchApiProfileProvider(profile, 'openai') : profile,
        ),
      }),
    )
    showToast(t('toast.providerDeleted'), 'success')
  }

  const handleCustomProviderJsonPaste = async () => {
    setIsImportingJson(true)
    try {
      const text = await navigator.clipboard.readText()
      if (!text.trim()) {
        throw new Error(t('toast.clipboardEmpty'))
      }
      const importedRaw = importCustomProviderSettingsFromJson(text, draft.customProviders)
      const imported = {
        customProviders: importedRaw.customProviders,
        profiles: importedRaw.profiles.map((p) => clientProfileToApiProfile(p)),
      }
      if (imported.profiles.length > 0) {
        const previousProfileIds = new Set(draft.profiles.map((profile) => profile.id))
        const mergedDraft = toDraftSettings(
          mergeImportedSettings(fromDraftSettings(draft), {
            customProviders: importedRaw.customProviders,
            profiles: importedRaw.profiles,
          }),
        )
        const importedProfile = getImportedProfileFromMergedSettings(
          fromDraftSettings(mergedDraft),
          previousProfileIds,
          { customProviders: importedRaw.customProviders, profiles: imported.profiles },
        )
        const importedProfileAlreadyExisted = previousProfileIds.has(importedProfile.id)
        const shouldReplaceActiveProfile =
          !editingCustomProviderId &&
          isPristineNewOpenAIProfile(activeProfile) &&
          !importedProfileAlreadyExisted
        const switchedToExistingProfile =
          !shouldReplaceActiveProfile && importedProfileAlreadyExisted
        const nextDraft = shouldReplaceActiveProfile
          ? normalizeDraftSettings({
              ...fromDraftSettings(mergedDraft),
              profiles: mergedDraft.profiles
                .filter(
                  (profile) => profile.id === activeProfile.id || profile.id !== importedProfile.id,
                )
                .map((profile) =>
                  profile.id === activeProfile.id
                    ? { ...importedProfile, id: activeProfile.id }
                    : profile,
                )
                .map(apiProfileToClientProfile),
              activeProfileId: activeProfile.id,
            })
          : normalizeDraftSettings({
              ...fromDraftSettings(mergedDraft),
              activeProfileId: importedProfile.id,
            })
        setDraft(nextDraft)
        setSettings(fromDraftSettings(nextDraft))
        setTimeoutInput(String(getActiveDraftProfile(nextDraft).timeout))
        closeCustomProviderDialog()
        setCustomProviderImportError(null)
        showToast(
          shouldReplaceActiveProfile
            ? t('toast.overwroteEmptyProfile')
            : switchedToExistingProfile
              ? t('toast.switchedToExisting')
              : t('toast.jsonImportedAndSwitched'),
          'success',
        )
        return
      }

      setCustomProviderForm(customProviderToForm(imported.customProviders[0]))
      setCustomProviderImportError(null)
      showToast(t('toast.jsonImported'), 'success')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setCustomProviderImportError(null)
      if (err instanceof Error && err.name === 'NotAllowedError') {
        showToast(t('toast.clipboardBlocked'), 'error')
      } else {
        showToast(msg, 'error')
      }
    } finally {
      setIsImportingJson(false)
    }
  }

  return (
    <>
      <div className="space-y-4">
        <div>
          <div className="mb-1.5 flex items-center gap-1.5">
            <span className="block text-sm text-muted-foreground">{t('profile.current')}</span>
            <span className="relative inline-flex">
              <button
                type="button"
                onClick={() => confirmCopyProfileImportUrl(activeProfile)}
                onMouseEnter={() => setProfileImportUrlTooltipVisible(true)}
                onMouseLeave={() => setProfileImportUrlTooltipVisible(false)}
                onFocus={() => setProfileImportUrlTooltipVisible(true)}
                onBlur={() => setProfileImportUrlTooltipVisible(false)}
                onTouchStart={() => {
                  clearProfileImportUrlTooltipTimer()
                  profileImportUrlTooltipTimerRef.current = window.setTimeout(() => {
                    setProfileImportUrlTooltipVisible(true)
                    profileImportUrlTooltipTimerRef.current = null
                  }, 450)
                }}
                onTouchEnd={clearProfileImportUrlTooltipTimer}
                onTouchCancel={clearProfileImportUrlTooltipTimer}
                className="flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-muted-foreground hover:bg-accent"
                aria-label={t('profile.copyImportUrlFor', { name: activeProfile.name })}
              >
                <LinkIcon className="h-3.5 w-3.5" />
              </button>
              <ViewportTooltip
                visible={profileImportUrlTooltipVisible}
                className="whitespace-nowrap"
              >
                {t('profile.copyImportUrl')}
              </ViewportTooltip>
            </span>
            {!activeIsBuiltin && (
              <span className="relative inline-flex">
                <button
                  type="button"
                  onClick={duplicateActiveProfile}
                  onMouseEnter={() => setDuplicateProfileTooltipVisible(true)}
                  onMouseLeave={() => setDuplicateProfileTooltipVisible(false)}
                  onFocus={() => setDuplicateProfileTooltipVisible(true)}
                  onBlur={() => setDuplicateProfileTooltipVisible(false)}
                  onTouchStart={() => {
                    clearDuplicateProfileTooltipTimer()
                    duplicateProfileTooltipTimerRef.current = window.setTimeout(() => {
                      setDuplicateProfileTooltipVisible(true)
                      duplicateProfileTooltipTimerRef.current = null
                    }, 450)
                  }}
                  onTouchEnd={clearDuplicateProfileTooltipTimer}
                  onTouchCancel={clearDuplicateProfileTooltipTimer}
                  className="flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-muted-foreground hover:bg-accent"
                  aria-label={t('profile.duplicateAria', { name: activeProfile.name })}
                >
                  <CopyIcon className="h-3.5 w-3.5" />
                </button>
                <ViewportTooltip
                  visible={duplicateProfileTooltipVisible}
                  className="whitespace-nowrap"
                >
                  {t('profile.duplicate')}
                </ViewportTooltip>
              </span>
            )}
          </div>
          <div ref={profileMenuRef} className="relative">
            <button
              ref={profileMenuTriggerRef}
              type="button"
              onClick={() => {
                if (!showProfileMenu) updateProfileMenuMaxHeight()
                setShowProfileMenu(!showProfileMenu)
              }}
              className="flex w-full min-w-0 items-center justify-between gap-2 rounded-xl border border-border/70 bg-card/60 px-3 py-2 text-sm text-foreground outline-none transition hover:bg-card border-border"
              title={activeProfile.name}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate">{activeProfile.name}</span>
                <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                  {getApiProviderLabel(draft, activeProfile.provider)}
                </span>
              </span>
              <ChevronDownIcon
                className={`w-3.5 h-3.5 flex-shrink-0 text-muted-foreground dark:text-muted-foreground transition-transform duration-200 ${showProfileMenu ? 'rotate-180' : ''}`}
              />
            </button>

            {showProfileMenu && (
              <>
                <div
                  className="absolute right-0 top-full z-50 mt-1.5 w-full overflow-hidden overflow-y-auto rounded-xl border border-border/60 bg-card/95 py-1 shadow-[0_8px_30px_rgb(0,0,0,0.12)] ring-1 ring-black/5 backdrop-blur-xl animate-dropdown-down border-border dark:shadow-[0_8px_30px_rgb(0,0,0,0.3)] dark:ring-white/10 custom-scrollbar"
                  style={{ maxHeight: profileMenuMaxHeight }}
                >
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault()
                      createNewProfile()
                    }}
                    className="flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-2 text-left text-xs font-medium text-primary transition-colors hover:bg-primary/10"
                  >
                    <span className="truncate font-semibold">{t('profile.create')}</span>
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                      <PlusIcon className="h-4 w-4" />
                    </span>
                  </button>
                  <div>
                    {draft.profiles.map((profile) => (
                      <div
                        key={profile.id}
                        title={profile.name}
                        onClick={(e) => {
                          e.preventDefault()
                          switchProfile(profile.id)
                        }}
                        className={`flex w-full cursor-pointer items-center justify-between px-3 py-2 text-left text-xs transition-colors ${profile.id === activeProfile.id ? 'bg-primary/10 font-medium text-primary dark:bg-primary/10 dark:text-primary' : 'text-foreground hover:bg-card dark:text-foreground hover:bg-accent'}`}
                      >
                        <div className="flex min-w-0 flex-1 items-center gap-2 pr-2">
                          <span className="min-w-0 truncate">{profile.name}</span>
                          {isBuiltinDraftProfile(profile) && (
                            <span className="rounded bg-warning/10 px-1.5 py-0.5 text-[10px] shrink-0 text-warning dark:bg-warning/20 dark:text-warning">
                              {t('profile.builtinBadge')}
                            </span>
                          )}
                          <span
                            className={`rounded px-1.5 py-0.5 text-[10px] shrink-0 ${profile.id === activeProfile.id ? 'bg-primary/10 text-primary dark:bg-primary/20 dark:text-primary' : 'bg-muted text-muted-foreground bg-accent dark:text-muted-foreground'}`}
                          >
                            {getApiProviderLabel(draft, profile.provider)}
                          </span>
                        </div>

                        <div className="flex shrink-0 items-center gap-1">
                          {!isBuiltinDraftProfile(profile) && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.preventDefault()
                                e.stopPropagation()
                                confirmCopyProfileImportUrl(profile)
                              }}
                              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-60 transition-all hover:bg-muted hover:text-muted-foreground hover:opacity-100 hover:bg-accent"
                              aria-label={t('profile.copyImportUrlFor', {
                                name: profile.name,
                              })}
                              title={t('profile.copyImportUrl')}
                            >
                              <LinkIcon className="h-3.5 w-3.5" />
                            </button>
                          )}
                          {draft.profiles.length > 1 && !isBuiltinDraftProfile(profile) && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.preventDefault()
                                e.stopPropagation()
                                setConfirmDialog({
                                  title: t('profile.delete'),
                                  message: t('profile.deleteMessage', {
                                    name: profile.name,
                                  }),
                                  action: () => deleteProfile(profile.id),
                                })
                              }}
                              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-60 transition-all hover:bg-destructive/10 hover:text-destructive hover:opacity-100 dark:hover:bg-destructive/10"
                              aria-label={t('profile.delete')}
                            >
                              <TrashIcon className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        {activeIsBuiltin ? (
          <div className="rounded-xl border border-warning bg-warning/10 px-3 py-2 text-xs text-warning dark:border-warning/30 dark:bg-warning/10 dark:text-warning">
            {t('profile.builtinModel')}
          </div>
        ) : (
          <>
            <label className="block">
              <span className="mb-1.5 block text-sm text-muted-foreground">
                {t('profile.name')}
              </span>
              <input
                value={activeProfile.name}
                onChange={(e) => updateActiveProfile({ name: e.target.value })}
                onBlur={(e) => commitActiveProfilePatch({ name: e.target.value })}
                type="text"
                readOnly={activeIsBuiltin}
                className={`w-full rounded-xl border border-border/70 bg-background px-3 py-2.5 text-sm text-foreground outline-none transition focus:border-primary border-border dark:text-foreground dark:focus:border-primary/50 ${activeIsBuiltin ? 'cursor-not-allowed opacity-60' : ''}`}
              />
            </label>

            <div className="block">
              <span className="mb-1.5 block text-sm text-muted-foreground">
                {t('provider.type')}
              </span>
              <Select
                value={activeProfile.provider}
                onChange={handleProviderTypeChange}
                options={providerOptions}
                className="w-full rounded-xl border border-border/70 bg-card/60 px-3 py-2.5 text-sm text-foreground outline-none transition focus:border-primary border-border"
              />
            </div>

            {activeProviderUsesApiUrl && (
              <label className="block">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="block text-sm text-muted-foreground">API URL</span>
                </div>
                <input
                  value={activeProfile.baseUrl}
                  onChange={(e) => updateActiveProfile({ baseUrl: e.target.value })}
                  onBlur={(e) => commitActiveProfilePatch({ baseUrl: e.target.value })}
                  type="text"
                  disabled={apiProxyEnabled}
                  readOnly={activeIsBuiltin}
                  placeholder={DEFAULT_BYOK_BASEURL}
                  className={`w-full rounded-xl border border-border/70 bg-background px-3 py-2.5 text-sm text-foreground outline-none transition focus:border-primary border-border dark:text-foreground dark:focus:border-primary/50 ${apiProxyEnabled || activeIsBuiltin ? 'opacity-50 cursor-not-allowed' : ''}`}
                />
                <div
                  data-selectable-text
                  className="mt-1.5 min-h-[22px] flex items-center text-xs text-muted-foreground"
                >
                  {apiProxyEnabled ? (
                    <span className="text-warning dark:text-warning">
                      {t('apiUrl.proxyIgnored')}
                    </span>
                  ) : (
                    <span>
                      {t('hint.queryOverride')}
                      <code className="bg-muted px-1 py-0.5 rounded">?apiUrl=</code>
                    </span>
                  )}
                </div>
              </label>
            )}

            {activeProfile.provider === 'openai' && (
              <div className="block">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="block text-sm text-muted-foreground">{t('codexCli.label')}</span>
                  <Switch
                    checked={activeProfile.codexCli}
                    onChange={(checked) => updateActiveProfile({ codexCli: checked }, true)}
                    aria-label={t('codexCli.label')}
                  />
                </div>
                <div data-selectable-text className="text-xs text-muted-foreground">
                  {t('codexCli.hint')}
                  <code className="bg-muted px-1 py-0.5 rounded">codexCli=true</code>
                  {t('hint.period')}
                </div>
              </div>
            )}

            {apiProxyAvailable && activeProfile.provider === 'openai' && (
              <div className="block">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="block text-sm text-muted-foreground">{t('apiProxy.label')}</span>
                  <Switch
                    checked={apiProxyChecked}
                    onChange={(checked) => updateActiveProfile({ apiProxy: checked }, true)}
                    aria-label={t('apiProxy.label')}
                  />
                </div>
                <div data-selectable-text className="text-xs text-muted-foreground">
                  {t('apiProxy.hint')}
                </div>
              </div>
            )}

            <div className="block">
              <span className="mb-1.5 block text-sm text-muted-foreground">API Key</span>
              <div className="relative">
                <input
                  value={activeProfile.apiKey}
                  onChange={(e) => updateActiveProfile({ apiKey: e.target.value })}
                  onBlur={(e) => commitActiveProfilePatch({ apiKey: e.target.value })}
                  type={showApiKey ? 'text' : 'password'}
                  readOnly={activeIsBuiltin}
                  placeholder="sk-..."
                  className={`w-full rounded-xl border border-border/70 bg-background px-3 py-2.5 pr-10 text-sm text-foreground outline-none transition focus:border-primary border-border dark:text-foreground dark:focus:border-primary/50 ${activeIsBuiltin ? 'opacity-50 cursor-not-allowed' : ''}`}
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-muted-foreground transition-colors"
                  tabIndex={-1}
                >
                  {showApiKey ? (
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      viewBox="0 0 24 24"
                    >
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  ) : (
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      viewBox="0 0 24 24"
                    >
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                      <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
                      <line x1="1" y1="1" x2="23" y2="23" />
                    </svg>
                  )}
                </button>
              </div>
              <div data-selectable-text className="mt-1.5 text-xs text-muted-foreground">
                {t('hint.queryOverride')}
                <code className="bg-muted px-1 py-0.5 rounded">?apiKey=</code>
              </div>
            </div>

            {activeProfile.provider === 'openai' && (
              <div className="block">
                <span className="mb-1.5 block text-sm text-muted-foreground">
                  {t('apiMode.label')}
                </span>
                <Select
                  value={activeProfile.apiMode ?? ('images' as const)}
                  onChange={(value) => {
                    const apiMode = value as 'images' | 'responses'
                    const nextModel =
                      activeProfile.model === DEFAULT_IMAGES_MODEL ||
                      activeProfile.model === DEFAULT_RESPONSES_MODEL
                        ? getDefaultModelForMode(apiMode)
                        : activeProfile.model
                    updateActiveProfile({ apiMode, model: nextModel }, true)
                  }}
                  options={[
                    { label: 'Images API (/v1/images)', value: 'images' },
                    { label: 'Responses API (/v1/responses)', value: 'responses' },
                  ]}
                  className="w-full rounded-xl border border-border/70 bg-card/60 px-3 py-2.5 text-sm text-foreground outline-none transition focus:border-primary border-border"
                />
                <div data-selectable-text className="mt-1.5 text-xs text-muted-foreground">
                  {t('hint.queryOverride')}
                  <code className="rounded bg-muted px-1 py-0.5">apiMode=images</code>{' '}
                  {t('hint.or')}{' '}
                  <code className="rounded bg-muted px-1 py-0.5">apiMode=responses</code>
                  {t('hint.period')}
                </div>
              </div>
            )}

            <label className="block">
              <span className="mb-1.5 block text-sm text-muted-foreground">{t('model.label')}</span>
              {(() => {
                const fallbackOptions = getProviderModelOptions(activeProfile.provider)
                const cached = profileModelCache[activeProfile.id] ?? []
                const comboOptions = Array.from(new Set([...cached, ...fallbackOptions]))
                const handleRefresh = async () => {
                  if (refreshingModels) return
                  setRefreshingModels(true)
                  try {
                    const kind: ProviderKind =
                      activeProfile.provider === 'gemini' ? 'gemini' : 'openai-compat'
                    const models = await fetchProfileModels({
                      baseUrl: activeProfile.baseUrl,
                      apiKey: activeProfile.apiKey,
                      kind,
                    })
                    setProfileModelCache(activeProfile.id, models)
                    showToast(t('model.fetched', { count: models.length }), 'success')
                  } catch (err) {
                    showToast(err instanceof Error ? err.message : t('model.fetchFailed'), 'error')
                  } finally {
                    setRefreshingModels(false)
                  }
                }
                return (
                  <>
                    <div className="flex items-center gap-2">
                      <div className="flex-1">
                        <ModelCombobox
                          value={activeProfile.model}
                          onChange={(val) => updateActiveProfile({ model: val })}
                          onCommit={(val) => commitActiveProfilePatch({ model: val })}
                          options={comboOptions}
                          placeholder={getDefaultModelForMode(
                            activeProfile.apiMode ?? ('images' as const),
                          )}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={handleRefresh}
                        disabled={refreshingModels}
                        className="shrink-0 rounded-xl border border-border/70 bg-card/60 px-3 py-2.5 text-xs text-muted-foreground transition hover:border-primary hover:text-primary disabled:opacity-50 disabled:cursor-not-allowed border-border"
                        title={t('model.fetchTitle')}
                      >
                        {refreshingModels ? t('model.fetching') : t('model.fetch')}
                      </button>
                    </div>
                    {cached.length > 0 && (
                      <div className="mt-1 text-xs text-muted-foreground">
                        {t('model.cachedCount', { count: cached.length })}
                      </div>
                    )}
                  </>
                )
              })()}
              <div data-selectable-text className="mt-1.5 text-xs text-muted-foreground">
                {activeCustomProvider ? (
                  <>
                    {t('model.usingProvider')}{' '}
                    <code className="rounded bg-muted px-1 py-0.5">
                      {activeCustomProvider.name}
                    </code>
                    {t('hint.period')}
                  </>
                ) : (activeProfile.apiMode ?? ('images' as const)) === 'responses' ? (
                  <>
                    {t('model.responsesHintPrefix')}{' '}
                    <code className="rounded bg-muted px-1 py-0.5">image_generation</code>{' '}
                    {t('model.responsesHintSuffix')}{' '}
                    <code className="rounded bg-muted px-1 py-0.5">{DEFAULT_RESPONSES_MODEL}</code>
                    {t('hint.period')}
                  </>
                ) : (
                  <>
                    {t('model.imagesHint')}{' '}
                    <code className="rounded bg-muted px-1 py-0.5">{DEFAULT_IMAGES_MODEL}</code>
                    {t('hint.period')}
                  </>
                )}
                {activeProfile.provider === 'openai' && (
                  <>
                    {t('hint.queryOverride')}
                    <code className="rounded bg-muted px-1 py-0.5">?model=</code>
                    {t('hint.period')}
                  </>
                )}
              </div>
            </label>

            {activeProviderIsOpenAICompatible && (
              <div className="block">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="block text-sm text-muted-foreground">{t('b64.label')}</span>
                  <Switch
                    checked={!!activeProfile.responseFormatB64Json}
                    onChange={(checked) =>
                      updateActiveProfile({ responseFormatB64Json: checked }, true)
                    }
                    aria-label={t('b64.label')}
                  />
                </div>
                <div data-selectable-text className="text-xs text-muted-foreground">
                  {t('b64.hintPrefix')}{' '}
                  <code className="bg-muted px-1 py-0.5 rounded">response_format: b64_json</code>
                  {t('b64.hintSuffix')}
                </div>
              </div>
            )}

            {activeProviderIsOpenAICompatible && (
              <label className="block">
                <span className="mb-1.5 block text-sm text-muted-foreground">
                  {t('timeout.label')}
                </span>
                <input
                  value={timeoutInput}
                  onChange={(e) => setTimeoutInput(e.target.value)}
                  onBlur={commitTimeout}
                  type="number"
                  min={10}
                  max={600}
                  className="w-full rounded-xl border border-border/70 bg-card/60 px-3 py-2.5 text-sm text-foreground outline-none transition focus:border-primary border-border"
                />
              </label>
            )}
          </>
        )}
      </div>
      {showCustomProviderImport && (
        <CustomProviderDialog
          editing={editingCustomProviderId !== null}
          form={customProviderForm}
          error={customProviderImportError}
          importing={isImportingJson}
          onFormChange={updateCustomProviderForm}
          onPasteImport={handleCustomProviderJsonPaste}
          onSave={saveCustomProvider}
          onClose={closeCustomProviderDialog}
        />
      )}
      {copyImportUrlProfile && (
        <ImportUrlDialog
          profileName={copyImportUrlProfile.name}
          options={copyImportUrlOptions}
          onOptionsChange={updateCopyImportUrlOptions}
          onCopy={(includeApiKey) =>
            copyProfileImportUrl(copyImportUrlProfile, { ...copyImportUrlOptions, includeApiKey })
          }
          onClose={() => setCopyImportUrlProfile(null)}
        />
      )}
    </>
  )
}
