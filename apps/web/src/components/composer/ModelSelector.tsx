/**
 * Adapted from assistant-ui Elements `model-selector` (MIT, AgentbaseAI).
 * 只取外观与结构：沿用项目的 Radix Popover，不引入 cmdk / base-ui。
 */
import type { ModelBadge, ModelLogoId, ModelTier } from '@image-playground/shared'
import { type KeyboardEvent, useId, useMemo, useState, useSyncExternalStore } from 'react'
import { useTranslation } from '../../i18n'
import { clientProfileToApiProfile, getActiveApiProfile } from '../../lib/apiProfiles'
import { subscribeChannels } from '../../lib/channels/channelStore'
import {
  getProfileModelOptions,
  updateSelectedModel,
  usableEtaMaxSeconds,
  usableEtaSeconds,
} from '../../lib/channels/profileSelectors'
import { getPublicChannels } from '../../lib/channels/publicChannels'
import { cn } from '../../lib/utils'
import { useStore } from '../../store'
import { compactModelName, ModelLogo } from '../ModelIdentity'
import Badge from '../patterns/Badge'
import SearchField from '../patterns/SearchField'
import { Button } from '../ui/button'
import { Icon, type IconName } from '../ui/icon'
import { OverflowText, useOverflowTitle } from '../ui/overflowTitle'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { type ComposerControlSize, composerModelChipClass } from './SettingsPanel'

export interface ModelChoice {
  value: string
  model: string
  profileId: string
  /** 该渠道给这个模型声明的图标；不写按 id 前缀给厂商图标。 */
  logo?: ModelLogoId
  label: string
  description?: string
  /** 渠道下发的标签 token；只有 'latest' 会显示，是名字旁一枚很小的「New」。 */
  badges?: readonly ModelBadge[]
  /** 选择器分组（快速 / 高质量）；没有就排在分组后面，不带组头。 */
  tier?: ModelTier
  /** 典型单张耗时，显示成「约 N 秒」，一分钟以上显示成「约 N 分钟」。 */
  etaSeconds?: number
  /** 耗时随档位变化时的上界，有就显示成「约 N–M 秒」。 */
  etaMaxSeconds?: number
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
  const publicChannels = useSyncExternalStore(
    subscribeChannels,
    getPublicChannels,
    getPublicChannels,
  )
  const options = useMemo(() => {
    return settings.profiles.flatMap((profile) => {
      const view = clientProfileToApiProfile(profile)
      return getProfileModelOptions(profile, publicChannels).map(
        (option): ModelChoice => ({
          value: `${profile.id}::${option.id}`,
          model: option.id,
          profileId: profile.id,
          label: compactModelName(option.id, option.label),
          description: view.name,
          ...(option.badges ? { badges: option.badges } : {}),
          ...(option.tier ? { tier: option.tier } : {}),
          ...(option.etaSeconds !== undefined ? { etaSeconds: option.etaSeconds } : {}),
          ...(option.etaMaxSeconds !== undefined ? { etaMaxSeconds: option.etaMaxSeconds } : {}),
          ...(option.logo ? { logo: option.logo } : {}),
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

/** 分组顺序与组头图标：快速组在前，组头只有一个小图标加组名，不配说明文字。 */
const TIER_ORDER: readonly ModelTier[] = ['fast', 'quality']
const TIER_ICON: Record<ModelTier, IconName> = { fast: 'speed', quality: 'quality' }
const TIER_LABEL_KEY = {
  fast: 'param.modelTier.fast',
  quality: 'param.modelTier.quality',
} as const satisfies Record<ModelTier, string>

interface ModelGroup {
  tier?: ModelTier
  options: ModelChoice[]
}

/** 组内从快到慢；没写耗时的排在组尾，同档保持渠道顺序。 */
function byEta(a: ModelChoice, b: ModelChoice) {
  const left = usableEtaSeconds(a.etaSeconds)
  const right = usableEtaSeconds(b.etaSeconds)
  if (left === right) return 0
  if (left === undefined) return 1
  if (right === undefined) return -1
  return left - right
}

/** 有任何一项带分组才分组；都不带（比如文本模型列表）就原样一组、不出组头。 */
function groupByTier(options: readonly ModelChoice[]): ModelGroup[] {
  if (!options.some((option) => option.tier)) return [{ options: [...options] }]
  const groups: ModelGroup[] = TIER_ORDER.map((tier) => ({
    tier,
    options: options.filter((option) => option.tier === tier).sort(byEta),
  })).filter((group) => group.options.length > 0)
  const rest = options.filter((option) => !option.tier)
  return rest.length ? [...groups, { options: rest }] : groups
}

/**
 * 名字一行（新模型在名字旁带一枚很小的 New），有预估耗时时在下一行用次要文字写「约 N 秒」。
 * 快慢和画质交给分组表达，名字后面不挂说明标签。
 * 写成返回元素的函数而不是组件：Button 靠静态遍历 children 判断有没有可见文字，
 * 包一层组件它就看不见名字，会把 aria-label 当成悬停提示再显示一遍。
 */
function modelOptionName(
  option: ModelChoice,
  newLabel: string | undefined,
  eta: string | undefined,
) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="flex min-w-0 items-center gap-1.5">
        <span title={option.label} className="min-w-0 truncate font-medium text-foreground">
          {option.label}
        </span>
        {newLabel ? (
          <Badge tone="primary" className="shrink-0 px-1">
            {newLabel}
          </Badge>
        ) : null}
      </span>
      {eta ? (
        <span title={eta} className="min-w-0 truncate text-label-sm text-muted-foreground">
          {eta}
        </span>
      ) : null}
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
  const newLabel = (option: ModelChoice) =>
    option.badges?.includes('latest') ? t('param.modelNew') : undefined
  // 一分钟以上按分钟说：「约 80 秒」不如「约 1 分钟」好读，预估本来就只是量级。
  const etaLabel = (seconds: number, maxSeconds: number | undefined) => {
    if (maxSeconds !== undefined) {
      // 两分钟以内按秒写范围（「约 40–100 秒」），再长才换成分钟，免得 100 秒被四舍五入成「约 2 分钟」。
      if (maxSeconds < 120) return t('param.modelEtaRange', { min: seconds, max: maxSeconds })
      const min = Math.max(1, Math.round(seconds / 60))
      const max = Math.round(maxSeconds / 60)
      if (max > min) return t('param.modelEtaRangeMinutes', { min, max })
      return t('param.modelEtaMinutes', { minutes: max })
    }
    return seconds < 60
      ? t('param.modelEta', { seconds })
      : t('param.modelEtaMinutes', { minutes: Math.round(seconds / 60) })
  }
  const [query, setQuery] = useState('')
  const listId = useId()
  const needle = query.trim().toLocaleLowerCase()
  const visible = needle
    ? options.filter((option) =>
        [
          option.label,
          option.model,
          option.description ?? '',
          option.tier ? t(TIER_LABEL_KEY[option.tier]) : '',
        ]
          .join(' ')
          .toLocaleLowerCase()
          .includes(needle),
      )
    : options
  const groups = groupByTier(visible)
  const firstShown = groups[0]?.options[0]
  const hasSelected = visible.some((option) => option.value === value)
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
        {groups.map((group, groupIndex) => {
          const headingId = `${listId}-${group.tier ?? 'rest'}`
          const rows = group.options.map((option) => {
            const selected = option.value === value
            const tabStop = selected || (option === firstShown && !hasSelected)
            const eta = usableEtaSeconds(option.etaSeconds)
            const etaText =
              eta !== undefined
                ? etaLabel(eta, usableEtaMaxSeconds(option.etaMaxSeconds, eta))
                : undefined
            const isNew = newLabel(option)
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
                  ...(isNew ? [isNew] : []),
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
                  <ModelLogo model={option.model} logo={option.logo ?? null} />
                </span>
                {modelOptionName(option, isNew, etaText)}
                {option.description && (
                  <OverflowText
                    text={option.description}
                    className="max-w-20 truncate text-label-sm text-muted-foreground"
                  />
                )}
                {selected && <Icon name="check" />}
              </Button>
            )
          })
          if (!group.tier)
            return (
              <div key="rest" className={cn(groupIndex > 0 && 'mt-1 border-t border-border pt-1')}>
                {rows}
              </div>
            )
          return (
            <div
              key={group.tier}
              role="group"
              aria-labelledby={headingId}
              className={cn(groupIndex > 0 && 'mt-1 border-t border-border pt-1')}
            >
              <div
                id={headingId}
                className="flex items-center gap-1.5 px-3 pt-2 pb-1 text-label-sm font-medium text-muted-foreground"
              >
                <Icon name={TIER_ICON[group.tier]} size="xs" />
                {t(TIER_LABEL_KEY[group.tier])}
              </div>
              {rows}
            </div>
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
              <ModelLogo model={current.model} logo={current.logo ?? null} />
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
