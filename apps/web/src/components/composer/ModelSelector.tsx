/**
 * Adapted from assistant-ui Elements `model-selector` (MIT, AgentbaseAI).
 * 只取外观与结构：沿用项目的 Radix Popover，不引入 cmdk / base-ui。
 */
import type { ModelBadge } from '@image-playground/shared'
import { type KeyboardEvent, useId, useMemo, useState, useSyncExternalStore } from 'react'
import { useTranslation } from '../../i18n'
import { clientProfileToApiProfile, getActiveApiProfile } from '../../lib/apiProfiles'
import { subscribeChannels } from '../../lib/channels/channelStore'
import {
  getProfileModelOptions,
  updateSelectedModel,
  usableEtaSeconds,
} from '../../lib/channels/profileSelectors'
import { getPublicChannels } from '../../lib/channels/publicChannels'
import { cn } from '../../lib/utils'
import { useStore } from '../../store'
import { compactModelName, ModelLogo } from '../ModelIdentity'
import Badge from '../patterns/Badge'
import SearchField from '../patterns/SearchField'
import { Button } from '../ui/button'
import { Icon } from '../ui/icon'
import { OverflowText, useOverflowTitle } from '../ui/overflowTitle'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { type ComposerControlSize, composerModelChipClass } from './SettingsPanel'

export interface ModelChoice {
  value: string
  model: string
  profileId: string
  /** 选项来自的渠道；图标按「渠道 + 模型」查声明。 */
  channelId?: string
  label: string
  description?: string
  /** 渠道下发的说明标签（最新 / 质量好 / 速度快 / 便宜），按顺序显示在名字后面。 */
  badges?: readonly ModelBadge[]
  /** 典型单张耗时，显示成「约 N 秒」，一分钟以上显示成「约 N 分钟」。 */
  etaSeconds?: number
}

/** 模型多到这个数才给搜索框。 */
const SEARCH_THRESHOLD = 8

/** 跨 profile 的模型快选：每个 profile 的预设模型 + 上游拉取缓存，切换时同时切 activeProfileId。 */
export function useModelChoices() {
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const activeProfile = useMemo(() => getActiveApiProfile(settings), [settings])
  const activeView = clientProfileToApiProfile(activeProfile)

  // 订阅渠道清单：清单晚到或只改了标签 / 耗时时 profiles 不一定变，不订阅就会停在旧选项上。
  const publicChannels = useSyncExternalStore(subscribeChannels, getPublicChannels)
  const options = useMemo(() => {
    return settings.profiles.flatMap((profile) => {
      const view = clientProfileToApiProfile(profile)
      return getProfileModelOptions(profile, publicChannels).map(
        (option): ModelChoice => ({
          value: `${profile.id}::${option.id}`,
          model: option.id,
          profileId: profile.id,
          channelId: profile.channelId,
          label: compactModelName(option.id, option.label),
          description: view.name,
          ...(option.badges ? { badges: option.badges } : {}),
          ...(option.etaSeconds !== undefined ? { etaSeconds: option.etaSeconds } : {}),
        }),
      )
    })
  }, [settings.profiles, publicChannels])

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

/** 列表内上下 / Home / End 移动焦点；选项本身是按钮，Enter / 空格直接选中。 */
function moveOptionFocus(event: KeyboardEvent<HTMLElement>) {
  const step = { ArrowDown: 1, ArrowUp: -1 }[event.key]
  if (step === undefined && event.key !== 'Home' && event.key !== 'End') return
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="option"]')]
  if (!items.length) return
  event.preventDefault()
  const index = items.indexOf(document.activeElement as HTMLElement)
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : (index + (step ?? 0) + items.length) % items.length
  items[index === -1 && step === -1 ? items.length - 1 : next]?.focus()
}

/** 「推荐」「最新」用芽绿，其余保持中性，绿色只做点缀。 */
const BADGE_TONE: Record<ModelBadge, 'primary' | 'neutral'> = {
  recommended: 'primary',
  latest: 'primary',
  quality: 'neutral',
  fast: 'neutral',
  value: 'neutral',
}

/**
 * 名字后接说明标签，有预估耗时时在下一行用次要文字写「约 N 秒」。
 * 写成返回元素的函数而不是组件：Button 靠静态遍历 children 判断有没有可见文字，
 * 包一层组件它就看不见名字，会把 aria-label 当成悬停提示再显示一遍。
 */
function modelOptionName(
  option: ModelChoice,
  badgeLabel: (badge: ModelBadge) => string,
  eta: string | undefined,
) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="flex min-w-0 flex-wrap items-center gap-1">
        <span className="min-w-0 break-words font-medium text-foreground">{option.label}</span>
        {option.badges?.map((badge) => (
          <Badge key={badge} tone={BADGE_TONE[badge]}>
            {badgeLabel(badge)}
          </Badge>
        ))}
      </span>
      {eta ? <span className="text-label-sm text-muted-foreground">{eta}</span> : null}
    </span>
  )
}

/** 紧凑模型列表：名称与渠道排在同一行，选中项右侧打勾。 */
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
  const badgeLabel = (badge: ModelBadge) => t(`param.modelBadge.${badge}`)
  // 一分钟以上按分钟说：「约 80 秒」不如「约 1 分钟」好读，预估本来就只是量级。
  const etaLabel = (seconds: number) =>
    seconds < 60
      ? t('param.modelEta', { seconds })
      : t('param.modelEtaMinutes', { minutes: Math.round(seconds / 60) })
  const [query, setQuery] = useState('')
  const listId = useId()
  const needle = query.trim().toLocaleLowerCase()
  const visible = needle
    ? options.filter((option) =>
        [
          option.label,
          option.model,
          option.description ?? '',
          ...(option.badges ?? []).map(badgeLabel),
        ]
          .join(' ')
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
          className="max-w-none"
        />
      )}
      <div
        id={listId}
        role="listbox"
        aria-label={t('param.model')}
        onKeyDown={moveOptionFocus}
        className="min-h-0 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {visible.map((option, index) => {
          const selected = option.value === value
          const tabStop = selected || (index === 0 && !visible.some((o) => o.value === value))
          const eta = usableEtaSeconds(option.etaSeconds)
          const etaText = eta !== undefined ? etaLabel(eta) : undefined
          return (
            <Button
              variant="ghost"
              key={option.value}
              type="button"
              role="option"
              aria-selected={selected}
              tabIndex={tabStop ? 0 : -1}
              aria-label={[
                option.label,
                ...(option.badges ?? []).map(badgeLabel),
                ...(etaText ? [etaText] : []),
                ...(option.description ? [option.description] : []),
              ].join(' · ')}
              onClick={() => onPick(option.value)}
              className={cn(
                'flex h-auto min-h-10 w-full justify-start whitespace-normal px-3 py-2 text-left text-body-sm focus-visible:bg-accent',
                selected && 'bg-accent',
              )}
            >
              <span className="flex shrink-0">
                <ModelLogo model={option.model} channelId={option.channelId} />
              </span>
              {modelOptionName(option, badgeLabel, etaText)}
              {option.description && (
                <OverflowText
                  text={option.description}
                  className="max-w-20 truncate text-label-sm text-muted-foreground"
                />
              )}
              {selected && <Icon name="check" />}
            </Button>
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
export function ModelSelector({
  size = 'md',
  label,
}: {
  size?: ComposerControlSize
  label?: string
}) {
  const { t } = useTranslation('composer')
  const { options, currentValue, current, pick } = useModelChoices()
  const [open, setOpen] = useState(false)
  const shown = label ?? current?.label ?? t('param.noModel')
  const name = useOverflowTitle<HTMLSpanElement>(shown, { whenHidden: true })
  if (options.length === 0 && !label) return null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size={size === 'md' ? 'chip-lg' : 'chip-sm'}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-label={`${t('param.model')} ${shown}`}
          title={name.title}
          disabled={options.length === 0}
          className={composerModelChipClass(size)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              setOpen(true)
            }
          }}
        >
          <span className="flex shrink-0 items-center text-muted-foreground">
            {!label && current ? (
              <ModelLogo model={current.model} channelId={current.channelId} />
            ) : (
              <Icon name="model" />
            )}
          </span>
          <span ref={name.ref} className="creation-model-name min-w-0 truncate">
            {shown}
          </span>
          <Icon
            name="chevronDown"
            aria-hidden="true"
            className={cn(
              'absolute top-1/2 h-4 w-4 -translate-y-1/2 opacity-50',
              size === 'md' ? 'right-3' : 'right-2',
            )}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={12}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          const content = event.currentTarget as HTMLElement
          content
            .querySelector<HTMLElement>('input, [role="option"][tabindex="0"]')
            ?.focus({ preventScroll: false })
        }}
        className="flex max-h-[min(26rem,var(--radix-popover-content-available-height))] w-80 max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-xl p-1 shadow-popover"
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
