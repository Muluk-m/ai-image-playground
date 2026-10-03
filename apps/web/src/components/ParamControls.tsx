import { parseImageSize } from '@image-playground/shared'
import { Ruler } from 'lucide-react'
import { memo, type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from '../i18n'
import { clientProfileToApiProfile, getActiveApiProfile } from '../lib/apiProfiles'
import { getProfileModelOptions, updateSelectedModel } from '../lib/channels/profileSelectors'
import { getPublicChannels } from '../lib/channels/publicChannels'
import { isByokGenerationEnabled } from '../lib/clientCapabilities'
import { getOutputImageLimitForSettings, getParamCapabilities } from '../lib/paramCompatibility'
import {
  normalizeSizeFor,
  PRESET_RATIOS,
  readSizeSelection,
  SIZE_TIERS,
  type SizeRules,
  sizeFor,
  sizeRatioLabel,
} from '../lib/size'
import { useStore } from '../store'
import {
  DEFAULT_PARAMS,
  GEMINI_ASPECT_RATIOS,
  GEMINI_IMAGE_SIZES,
  GEMINI_THINKING_LEVELS,
  type TaskParams,
} from '../types'
import { ChipIcons } from './chipIcons'
import {
  type ComposerControlSize,
  composerModelChipClass,
  DraftInput,
  RatioGrid,
  RatioShape,
  SettingsPopover,
  SettingsSection,
  SettingsSegmented,
  SettingsToggle,
} from './composer/SettingsPanel'
import { compactModelName, ModelLogo } from './ModelIdentity'
import Select from './Select'

/** 某条提交路径做不到的参数。开关直接不出现——显示了却不生效，比没有这个开关更糟。 */
export type UnsupportedParam = 'transparent' | 'noRewrite'

const FORMAT_LABELS: Record<TaskParams['output_format'], string> = {
  png: 'PNG',
  jpeg: 'JPEG',
  webp: 'WebP',
}

/** Gemini 的三项都以「不传」表示自动：选项里补一格 auto，写回时还原成 undefined。 */
const withAuto = (values: readonly string[], autoLabel: string) => [
  { value: 'auto', label: autoLabel },
  ...values.map((value) => ({ value, label: value })),
]
const fromAuto = <T,>(value: string) => (value === 'auto' ? undefined : (value as T))

/**
 * 模型 chip：跨 profile 的模型快选，切换时同时切 activeProfileId 与该 profile 的 model。
 * `label` 用来写这条路实际生效的模型（智能体在 BYOK 下只能用内置渠道）。
 */
export function ModelChip({ size = 'md', label }: { size?: ComposerControlSize; label?: string }) {
  const { t } = useTranslation('composer')
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const profileModelCache = useStore((s) => s.profileModelCache)
  const activeProfile = useMemo(() => getActiveApiProfile(settings), [settings])
  const activeView = clientProfileToApiProfile(activeProfile)

  // 每个 profile 的 (model + 上游拉取缓存) 扁平去重。
  const options = useMemo(() => {
    const publicChannels = getPublicChannels()
    const byokEnabled = isByokGenerationEnabled()
    const labelCounts = new Map<string, number>()
    const list = settings.profiles
      .filter((profile) => byokEnabled || profile.source === 'builtin-edge')
      .flatMap((profile) => {
        const view = clientProfileToApiProfile(profile)
        const presetOptions = getProfileModelOptions(profile, publicChannels)
        const knownIds = new Set(presetOptions.map((o) => o.id))
        const cachedExtras = (profileModelCache[profile.id] ?? [])
          .filter((id) => !knownIds.has(id))
          .map((id) => ({ id, label: id }))
        return [...presetOptions, ...cachedExtras].map((option) => {
          const name = compactModelName(option.id, option.label)
          labelCounts.set(name, (labelCounts.get(name) ?? 0) + 1)
          return {
            value: `${profile.id}::${option.id}`,
            model: option.id,
            profileId: profile.id,
            profileName: view.name,
            label: name,
            icon: <ModelLogo model={option.id} />,
            title: `${option.label} · ${view.name}\n${option.id}`,
            description: '',
          }
        })
      })
    for (const option of list) {
      if ((labelCounts.get(option.label) ?? 0) > 1) option.description = option.profileName
    }
    return list
  }, [settings.profiles, profileModelCache])

  if (options.length === 0) return null
  const currentValue = `${activeProfile.id}::${activeView.model}`
  const current = options.find((option) => option.value === currentValue)
  const pick = (rawValue: string) => {
    const option = options.find((o) => o.value === rawValue)
    if (!option || option.value === currentValue) return
    const publicChannels = getPublicChannels()
    const nextProfiles = settings.profiles.map((profile) =>
      profile.id === option.profileId
        ? updateSelectedModel(profile, option.model, publicChannels)
        : profile,
    )
    setSettings({ profiles: nextProfiles, activeProfileId: option.profileId })
  }
  const shown = label ?? current?.label ?? t('param.noModel')
  return (
    <div title={label ?? current?.title ?? shown} className={composerModelChipClass(size)}>
      <span className="flex shrink-0 items-center text-muted-foreground">
        {(!label && current?.icon) || ChipIcons.model}
      </span>
      <span className="min-w-0 truncate">{shown}</span>
      <Select
        value={currentValue}
        onChange={(value) => pick(String(value))}
        options={options}
        className="!justify-end !border-0 !bg-transparent !px-2.5 !py-0 !shadow-none h-full"
        wrapperClassName="absolute inset-0"
        hideSelectedLabel
        label={t('param.model')}
      />
    </div>
  )
}

/** 调用方塞进卡片的一组自有设置（智能体的思考深度），带着自己的默认判断与重置。 */
export interface ExtraSettings {
  section: ReactNode
  dirty: boolean
  reset: () => void
  /** 卡片最后的说明。 */
  footnote?: ReactNode
}

/**
 * 生成设置：摘要 chip（画幅与张数）+ 点开的设置卡片。全部读写全局 store。
 *
 * - `showCount`：张数可手选（直接生成）；智能体那条路由工具调用决定张数。
 * - `agentManaged`：这句话交给智能体，卡片里只剩画幅（比例 / 分辨率）。
 */
export function ImageSettings({
  showCount = false,
  agentManaged = false,
  unsupported,
  size = 'md',
  extra,
}: {
  showCount?: boolean
  agentManaged?: boolean
  unsupported?: ReadonlySet<UnsupportedParam>
  size?: ComposerControlSize
  extra?: ExtraSettings
}) {
  const { t } = useTranslation('composer')
  const params = useStore((s) => s.params)
  const setParams = useStore((s) => s.setParams)
  const settings = useStore((s) => s.settings)

  const activeProfile = useMemo(() => getActiveApiProfile(settings), [settings])
  const activeView = clientProfileToApiProfile(activeProfile)
  const isGemini = activeView.provider === 'gemini'
  const capabilities = getParamCapabilities(activeProfile, params.output_format)
  const tuning = isGemini && capabilities.geminiImageTuning
  const rules: SizeRules = { ratioOnly: !capabilities.size, limitTo1K: activeView.codexCli }
  const selection = useMemo(
    () =>
      readSizeSelection(params.size, {
        ratioOnly: !capabilities.size,
        limitTo1K: activeView.codexCli,
      }),
    [params.size, capabilities.size, activeView.codexCli],
  )
  const countVisible = showCount && !agentManaged
  const outputs = !isGemini && !agentManaged
  const transparentVisible =
    outputs && capabilities.transparentOutput && !unsupported?.has('transparent')
  const noRewriteVisible = outputs && !unsupported?.has('noRewrite')

  // 自定义：点了「自定义」但还没填出合法尺寸时，格子也要亮着。
  const [customOpen, setCustomOpen] = useState(false)
  const [clamped, setClamped] = useState(false)
  const customActive = !isGemini && (selection.kind === 'custom' || customOpen)
  /** 选预设会退出自定义；自定义宽高的提交留在自定义里，免得填完一边输入框就没了。 */
  const applySize = (next: string, { custom = false, wasClamped = false } = {}) => {
    setCustomOpen(custom)
    setClamped(wasClamped)
    setParams({ size: next })
  }

  const autoLabel = t('settings.auto')
  /** 当前比例：Gemini 读它自己的字段，其余从尺寸约出来。 */
  const ratio = isGemini
    ? (params.gemini_aspect_ratio ?? 'auto')
    : selection.kind === 'auto'
      ? 'auto'
      : selection.ratio
  const ratioLabel = ratio === 'auto' ? autoLabel : ratio
  const sizeSummary = isGemini
    ? [ratioLabel, tuning ? params.gemini_image_size : undefined]
    : selection.kind === 'custom'
      ? [capabilities.size ? params.size.replace('x', '×') : sizeRatioLabel(params.size)]
      : [ratioLabel, selection.kind === 'preset' && capabilities.size ? selection.tier : undefined]
  const summary = [...sizeSummary, countVisible ? t('settings.count', { count: params.n }) : '']
    .filter(Boolean)
    .join(' · ')
  // 摘要里看不到、又偏离了默认值的参数。
  const dirty =
    Boolean(extra?.dirty) ||
    (outputs &&
      ((capabilities.quality && params.quality !== DEFAULT_PARAMS.quality) ||
        params.output_format !== DEFAULT_PARAMS.output_format ||
        params.output_compression != null ||
        (transparentVisible && params.transparent_output) ||
        (noRewriteVisible && params.no_rewrite !== DEFAULT_PARAMS.no_rewrite))) ||
    (tuning && !agentManaged && Boolean(params.gemini_thinking_level))

  const reset = () => {
    const patch: Partial<TaskParams> = isGemini
      ? {
          gemini_aspect_ratio: undefined,
          gemini_image_size: undefined,
          ...(agentManaged ? {} : { gemini_thinking_level: undefined }),
        }
      : { size: DEFAULT_PARAMS.size }
    if (countVisible) patch.n = DEFAULT_PARAMS.n
    if (outputs) {
      Object.assign(patch, {
        quality: DEFAULT_PARAMS.quality,
        output_format: DEFAULT_PARAMS.output_format,
        output_compression: DEFAULT_PARAMS.output_compression,
        transparent_output: DEFAULT_PARAMS.transparent_output,
        no_rewrite: DEFAULT_PARAMS.no_rewrite,
      })
    }
    setCustomOpen(false)
    setClamped(false)
    setParams(patch)
    extra?.reset()
  }

  const commitPixels = (width: string, height: string) => {
    const w = Number.parseInt(width, 10)
    const h = Number.parseInt(height, 10)
    if (!(w > 0 && h > 0)) return
    const next = normalizeSizeFor(`${w}x${h}`, rules)
    applySize(next, { custom: true, wasClamped: next !== `${w}x${h}` })
  }

  // 卡片关着时不调用：分组只在打开时构建。
  const renderSections = () => {
    const pixels = parseImageSize(params.size)
    // 从「智能」进自定义时先给一个 1:1 的起点，改一边就能提交出完整尺寸。
    const draftPixels = pixels ?? { width: 1024, height: 1024 }
    const outputImageLimit = getOutputImageLimitForSettings(settings)
    const countOptions = Array.from({ length: outputImageLimit }, (_, i) => i + 1)

    const ratioOptions = isGemini
      ? withAuto(GEMINI_ASPECT_RATIOS, autoLabel)
      : [
          ...withAuto(PRESET_RATIOS, autoLabel),
          {
            value: 'custom',
            label: t('settings.custom'),
            icon: <Ruler aria-hidden="true" className="h-4 w-4" />,
          },
        ]
    const pickRatio = (value: string) => {
      if (isGemini) return setParams({ gemini_aspect_ratio: fromAuto(value) })
      if (value === 'custom') return setCustomOpen(true)
      if (value === 'auto') return applySize('auto')
      const next = sizeFor(selection.kind === 'preset' ? selection.tier : '1K', value, rules)
      if (next) applySize(next)
    }
    const customHint = clamped
      ? t('size.clampedHint')
      : !capabilities.size
        ? t('size.ratioOnlyNote')
        : undefined

    return (
      <>
        {extra?.section}
        <SettingsSection
          title={t('param.aspectRatio')}
          hint={customActive ? customHint : undefined}
        >
          <RatioGrid
            label={t('param.aspectRatio')}
            options={ratioOptions}
            value={customActive ? 'custom' : ratio}
            onChange={pickRatio}
          />
          {customActive &&
            (capabilities.size ? (
              <div className="flex items-center gap-2">
                <DraftInput
                  aria-label={t('size.width')}
                  inputMode="numeric"
                  placeholder="W"
                  value={String(draftPixels.width)}
                  onCommit={(width) => commitPixels(width, String(draftPixels.height))}
                />
                <span aria-hidden="true" className="text-muted-foreground">
                  ×
                </span>
                <DraftInput
                  aria-label={t('size.height')}
                  inputMode="numeric"
                  placeholder="H"
                  value={String(draftPixels.height)}
                  onCommit={(height) => commitPixels(String(draftPixels.width), height)}
                />
                <span className="text-label-sm text-muted-foreground">PX</span>
              </div>
            ) : (
              <DraftInput
                aria-label={t('size.customRatioLabel')}
                placeholder={t('size.customRatioPlaceholder')}
                value={selection.kind === 'custom' ? selection.ratio : ''}
                onCommit={(draft) => {
                  const next = sizeFor('1K', draft, rules)
                  if (next) applySize(next, { custom: true })
                }}
              />
            ))}
        </SettingsSection>

        {isGemini
          ? tuning && (
              <SettingsSection title={t('param.resolution')}>
                <SettingsSegmented
                  label={t('param.resolution')}
                  options={withAuto(GEMINI_IMAGE_SIZES, t('settings.autoOption'))}
                  value={params.gemini_image_size ?? 'auto'}
                  onChange={(value) => setParams({ gemini_image_size: fromAuto(value) })}
                />
              </SettingsSection>
            )
          : capabilities.size && (
              <SettingsSection
                title={t('param.resolution')}
                value={pixels ? `${pixels.width} × ${pixels.height}` : undefined}
                hint={
                  selection.kind === 'auto'
                    ? t('settings.autoSizeHint')
                    : rules.limitTo1K
                      ? t('size.limitedTierHint')
                      : undefined
                }
              >
                <SettingsSegmented
                  label={t('param.resolution')}
                  options={SIZE_TIERS.map((tier) => ({
                    value: tier,
                    label: tier,
                    disabled: selection.kind === 'auto' || (rules.limitTo1K && tier !== '1K'),
                  }))}
                  value={selection.kind === 'preset' && !customOpen ? selection.tier : null}
                  onChange={(tier) => {
                    const next =
                      selection.kind === 'auto' ? null : sizeFor(tier, selection.ratio, rules)
                    if (next) applySize(next)
                  }}
                />
              </SettingsSection>
            )}

        {countVisible && (
          <SettingsSection title={t('param.count')}>
            <SettingsSegmented
              label={t('param.count')}
              options={countOptions.map((n) => ({ value: n, label: String(n) }))}
              value={params.n}
              onChange={(n) => setParams({ n })}
            />
          </SettingsSection>
        )}

        {tuning && !agentManaged && (
          <SettingsSection title={t('param.thinking')}>
            <SettingsSegmented
              label={t('param.thinking')}
              options={withAuto(GEMINI_THINKING_LEVELS, t('settings.autoOption'))}
              value={params.gemini_thinking_level ?? 'auto'}
              onChange={(value) => setParams({ gemini_thinking_level: fromAuto(value) })}
            />
          </SettingsSection>
        )}

        {outputs && capabilities.quality && (
          <SettingsSection title={t('param.quality')}>
            <SettingsSegmented
              label={t('param.quality')}
              options={[
                { value: 'auto', label: t('settings.quality.auto') },
                { value: 'low', label: t('settings.quality.low') },
                { value: 'medium', label: t('settings.quality.medium') },
                { value: 'high', label: t('settings.quality.high') },
              ]}
              value={params.quality}
              onChange={(quality) => setParams({ quality })}
            />
          </SettingsSection>
        )}
        {outputs && (
          <SettingsSection title={t('param.format')}>
            <SettingsSegmented
              label={t('param.format')}
              options={(['png', 'jpeg', 'webp'] as const).map((value) => ({
                value,
                label: FORMAT_LABELS[value],
              }))}
              value={params.output_format}
              onChange={(format) =>
                setParams({
                  output_format: format,
                  ...(format === 'png'
                    ? { output_compression: null }
                    : { transparent_output: false }),
                })
              }
            />
          </SettingsSection>
        )}
        {outputs && capabilities.compression && (
          <SettingsSection title={t('param.compression')} hint={t('settings.compressionHint')}>
            <DraftInput
              aria-label={t('param.compression')}
              type="number"
              min={0}
              max={100}
              placeholder="0-100"
              value={params.output_compression == null ? '' : String(params.output_compression)}
              onCommit={(draft) => {
                if (draft.trim() === '') return setParams({ output_compression: null })
                const value = Number(draft)
                if (!Number.isNaN(value)) {
                  setParams({ output_compression: Math.min(100, Math.max(0, Math.round(value))) })
                }
              }}
            />
          </SettingsSection>
        )}
        {(transparentVisible || noRewriteVisible) && (
          <div className="space-y-3 border-t border-border pt-4">
            {transparentVisible && (
              <SettingsToggle
                label={t('param.transparent')}
                description={t('settings.transparentHint')}
                checked={params.transparent_output}
                onChange={(on) => setParams({ transparent_output: on, output_compression: null })}
              />
            )}
            {noRewriteVisible && (
              <SettingsToggle
                label={t('param.noRewrite')}
                description={t('settings.noRewriteHint')}
                checked={params.no_rewrite}
                onChange={(on) => setParams({ no_rewrite: on })}
              />
            )}
          </div>
        )}
        {extra?.footnote}
      </>
    )
  }

  return (
    <SettingsPopover
      title={t('settings.title')}
      summary={summary}
      icon={
        <RatioShape
          ratio={selection.kind === 'custom' ? selection.ratio : ratio}
          className="h-3.5 w-3.5"
        />
      }
      dirty={dirty}
      size={size}
      onReset={reset}
    >
      {renderSections}
    </SettingsPopover>
  )
}

/**
 * 输入框底部的生成参数：模型单独一个 chip，其余参数收进「生成设置」卡片。
 * 首页与画布生成栏用它；对话面板自己组合两半，多塞一组思考深度。
 * props 都是稳定值，memo 掉输入框每次按键带来的重渲染。
 */
const ParamControls = memo(function ParamControls({
  showCount = false,
  agentManaged = false,
  size = 'md',
}: {
  showCount?: boolean
  agentManaged?: boolean
  size?: ComposerControlSize
}) {
  return (
    <>
      <ModelChip size={size} />
      <ImageSettings showCount={showCount} agentManaged={agentManaged} size={size} />
    </>
  )
})

export default ParamControls
