/**
 * Adapted from assistant-ui Elements `model-selector` (MIT, AgentbaseAI).
 * 只取外观与结构：沿用项目的 Radix Popover，不引入 cmdk / base-ui。
 */
import { Check, ChevronDown } from 'lucide-react'
import { useId, useMemo, useState } from 'react'
import { useTranslation } from '../../i18n'
import { clientProfileToApiProfile, getActiveApiProfile } from '../../lib/apiProfiles'
import { getProfileModelOptions, updateSelectedModel } from '../../lib/channels/profileSelectors'
import { getPublicChannels } from '../../lib/channels/publicChannels'
import { isByokGenerationEnabled } from '../../lib/clientCapabilities'
import { cn } from '../../lib/utils'
import { useStore } from '../../store'
import { field } from '../assistant-ui/elements/surfaces'
import { ChipIcons } from '../chipIcons'
import { compactModelName, ModelLogo } from '../ModelIdentity'
import SearchField from '../SearchField'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { type ComposerControlSize, composerModelChipClass } from './SettingsPanel'

export interface ModelChoice {
  value: string
  model: string
  profileId: string
  label: string
  description: string
  title: string
}

/** 模型多到这个数才给搜索框。 */
const SEARCH_THRESHOLD = 8

/** 跨 profile 的模型快选：每个 profile 的预设模型 + 上游拉取缓存，切换时同时切 activeProfileId。 */
export function useModelChoices() {
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const profileModelCache = useStore((s) => s.profileModelCache)
  const activeProfile = useMemo(() => getActiveApiProfile(settings), [settings])
  const activeView = clientProfileToApiProfile(activeProfile)

  const options = useMemo(() => {
    const publicChannels = getPublicChannels()
    const byokEnabled = isByokGenerationEnabled()
    return settings.profiles
      .filter((profile) => byokEnabled || profile.source === 'builtin-edge')
      .flatMap((profile) => {
        const view = clientProfileToApiProfile(profile)
        const presetOptions = getProfileModelOptions(profile, publicChannels)
        const knownIds = new Set(presetOptions.map((o) => o.id))
        const cachedExtras = (profileModelCache[profile.id] ?? [])
          .filter((id) => !knownIds.has(id))
          .map((id) => ({ id, label: id }))
        return [...presetOptions, ...cachedExtras].map(
          (option): ModelChoice => ({
            value: `${profile.id}::${option.id}`,
            model: option.id,
            profileId: profile.id,
            label: compactModelName(option.id, option.label),
            description: view.name,
            title: `${option.label} · ${view.name}\n${option.id}`,
          }),
        )
      })
  }, [settings.profiles, profileModelCache])

  const currentValue = `${activeProfile.id}::${activeView.model}`
  const current = options.find((option) => option.value === currentValue)
  const pick = (value: string) => {
    const option = options.find((o) => o.value === value)
    if (!option || option.value === currentValue) return
    const publicChannels = getPublicChannels()
    const profiles = settings.profiles.map((profile) =>
      profile.id === option.profileId
        ? updateSelectedModel(profile, option.model, publicChannels)
        : profile,
    )
    setSettings({ profiles, activeProfileId: option.profileId })
  }
  return { options, currentValue, current, pick }
}

/** 模型列表：图标 + 名称 + 所属渠道，选中项右侧打勾。 */
export function ModelList({
  options,
  value,
  onPick,
  className,
}: {
  options: readonly ModelChoice[]
  value: string
  onPick: (value: string) => void
  className?: string
}) {
  const { t } = useTranslation('composer')
  const [query, setQuery] = useState('')
  const listId = useId()
  const needle = query.trim().toLocaleLowerCase()
  const visible = needle
    ? options.filter((option) =>
        `${option.label} ${option.model} ${option.description}`
          .toLocaleLowerCase()
          .includes(needle),
      )
    : options
  return (
    <div className={cn('flex min-h-0 flex-col gap-1', className)}>
      {options.length > SEARCH_THRESHOLD && (
        <SearchField
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('param.searchModel')}
          aria-label={t('param.searchModel')}
          aria-controls={listId}
          className={cn(
            field,
            'h-8 max-w-none rounded-lg border-transparent px-2.5 focus-within:border-foreground/15 focus-within:ring-0',
          )}
        />
      )}
      <div
        id={listId}
        role="listbox"
        aria-label={t('param.model')}
        className="min-h-0 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {visible.map((option) => {
          const selected = option.value === value
          return (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={selected}
              title={option.title}
              onClick={() => onPick(option.value)}
              className={cn(
                'relative flex w-full items-start gap-2 rounded-lg py-2 pe-9 ps-3 text-left text-sm transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none',
                selected && 'bg-accent',
              )}
            >
              <span className="mt-0.5 flex shrink-0">
                <ModelLogo model={option.model} />
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium text-foreground">{option.label}</span>
                <span className="truncate text-xs text-muted-foreground">{option.description}</span>
              </span>
              {selected && <Check aria-hidden="true" className="absolute end-3 top-2.5 h-4 w-4" />}
            </button>
          )
        })}
        {!visible.length && (
          <p className="px-3 py-4 text-center text-xs text-muted-foreground">
            {t('param.noModelMatch')}
          </p>
        )}
      </div>
    </div>
  )
}

/** 独立的模型选择 chip（首页、画布生成栏）。 */
export function ModelSelector({ size = 'md' }: { size?: ComposerControlSize }) {
  const { t } = useTranslation('composer')
  const { options, currentValue, current, pick } = useModelChoices()
  const [open, setOpen] = useState(false)
  if (options.length === 0) return null
  const shown = current?.label ?? t('param.noModel')
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-label={`${t('param.model')} ${shown}`}
          title={current?.title ?? shown}
          className={composerModelChipClass(size)}
        >
          <span className="flex shrink-0 items-center text-muted-foreground">
            {current ? <ModelLogo model={current.model} /> : ChipIcons.model}
          </span>
          <span className="min-w-0 truncate">{shown}</span>
          <ChevronDown
            aria-hidden="true"
            className={cn(
              'absolute top-1/2 h-4 w-4 -translate-y-1/2 opacity-50',
              size === 'md' ? 'right-3' : 'right-2',
            )}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={12}
        className="flex max-h-[min(26rem,var(--radix-popover-content-available-height))] w-72 max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-xl p-1 shadow-popover"
      >
        <ModelList
          options={options}
          value={currentValue}
          onPick={(value) => {
            pick(value)
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}
