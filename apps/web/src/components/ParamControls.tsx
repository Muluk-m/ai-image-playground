import {
  GPT_IMAGE_26_GIF_DURATIONS_MS,
  GPT_IMAGE_26_GIF_FRAMES,
  GPT_IMAGE_26_GIF_SIZES,
  imageSizeTier,
  isGptImage26Model,
  nearestImageSize,
  parseImageSize,
} from '@image-playground/shared'
import { memo, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from '../i18n'
import { clientProfileToApiProfile, getActiveApiProfile } from '../lib/apiProfiles'
import type { ClientProfile } from '../lib/channels/types'
import { useGptPremiumLocked } from '../lib/gptPremium'
import {
  gifFrameSize,
  type StillImageSettings,
  switchImageOutputFormat,
} from '../lib/image26Format'
import { getOutputImageLimitForSettings, getParamCapabilities } from '../lib/paramCompatibility'
import {
  normalizeSizeFor,
  PRESET_RATIOS,
  readSizeSelection,
  SIZE_TIERS,
  type SizeRules,
  type SizeTier,
  sizeFor,
  sizeRatioLabel,
  tierFits,
} from '../lib/size'
import { useStore } from '../store'
import {
  DEFAULT_PARAMS,
  GEMINI_ASPECT_RATIOS,
  GEMINI_THINKING_LEVELS,
  type TaskParams,
} from '../types'
import { ModelSelector } from './composer/ModelSelector'
import {
  type ComposerControlSize,
  DraftInput,
  RatioGrid,
  RatioShape,
  SettingsPopover,
  SettingsSection,
  SettingsSegmented,
  SettingsToggle,
} from './composer/SettingsPanel'
import Badge from './patterns/Badge'
import { Icon } from './ui/icon'

/** 某条提交路径做不到的参数。开关直接不出现——显示了却不生效，比没有这个开关更糟。 */
export type UnsupportedParam = 'transparent' | 'noRewrite'

const FORMAT_LABELS: Record<TaskParams['output_format'], string> = {
  png: 'PNG',
  jpeg: 'JPEG',
  webp: 'WebP',
  gif: 'GIF',
  svg: 'SVG',
}

/** Gemini 的三项都以「不传」表示自动：选项里补一格 auto，写回时还原成 undefined。 */
const withAuto = (values: readonly string[], autoLabel: string) => [
  { value: 'auto', label: autoLabel },
  ...values.map((value) => ({ value, label: value })),
]
const fromAuto = <T,>(value: string) => (value === 'auto' ? undefined : (value as T))

/** 调用方塞进卡片的一组自有设置（智能体的思考深度），带着自己的默认判断与重置。 */
/**
 * 不读写全局 store 的一份参数：确认草稿时改的是草稿自己的参数，按草稿选定的渠道与模型
 * 判断哪些参数可用。
 */
export interface ControlledParams {
  params: TaskParams
  profile: ClientProfile
  onChange: (patch: Partial<TaskParams>) => void
}

export interface ExtraSettings {
  section: ReactNode
  dirty: boolean
  reset: () => void
  /** 摘要后的状态标记。 */
  badge?: ReactNode
  /** 只进 chip 的悬停与读屏名，不进可见摘要。 */
  detail?: string
  /** 卡片最后的说明。 */
  footnote?: ReactNode
}

/**
 * 生成设置：摘要 chip（画幅与张数）+ 点开的设置卡片。默认读写全局 store；传了 `controlled`
 * 就只读写调用方给的参数，可用项按它的 profile 判断。
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
  controlled,
  fixedCount,
}: {
  showCount?: boolean
  agentManaged?: boolean
  unsupported?: ReadonlySet<UnsupportedParam>
  size?: ComposerControlSize
  extra?: ExtraSettings
  controlled?: ControlledParams
  /** 张数由别处定死（逐张生成：一张参考图出一张）：摘要写这个数，卡片里数量只读。 */
  fixedCount?: number
}) {
  const { t } = useTranslation('composer')
  const storedParams = useStore((s) => s.params)
  const setStoredParams = useStore((s) => s.setParams)
  const params = controlled?.params ?? storedParams
  const setParams = controlled?.onChange ?? setStoredParams
  const settings = useStore((s) => s.settings)

  const controlledProfile = controlled?.profile
  const activeProfile = useMemo(
    () => controlledProfile ?? getActiveApiProfile(settings),
    [controlledProfile, settings],
  )
  const activeView = clientProfileToApiProfile(activeProfile)
  const isGemini = activeView.provider === 'gemini'
  const capabilities = getParamCapabilities(activeProfile, params.output_format)
  const tuning = isGemini && capabilities.geminiImageTuning
  const image26 = isGptImage26Model(activeView.model)
  const stillImage = useRef<StillImageSettings | null>(null)
  const specialFormat = params.output_format === 'gif' || params.output_format === 'svg'
  // 失焦回调可能是切格式之前那次渲染留下的，受控模式靠这个 ref 读到最新格式。
  const latestControlledFormat = useRef(params.output_format)
  latestControlledFormat.current = params.output_format
  const referenceCount = useStore((s) => (controlled ? 0 : s.inputImages.length))
  const hasMask = useStore((s) => (controlled ? false : Boolean(s.maskDraft)))
  const editing = referenceCount > 0 || hasMask
  const premium = useGptPremiumLocked(activeView.model, capabilities.size)
  // 2.6 自己锁 4K，不走非会员 2K 上限；其它 GPT 跟会员档位走。
  const maxTier: SizeTier = activeView.codexCli ? '1K' : image26 ? '4K' : premium.maxTier
  const rules = useMemo<SizeRules>(
    () => ({ ratioOnly: !capabilities.size, maxTier }),
    [capabilities.size, maxTier],
  )
  const selection = useMemo(
    () => readSizeSelection(params.size, { ratioOnly: !capabilities.size, maxTier }),
    [params.size, capabilities.size, maxTier],
  )
  // 已存的 4K / 高画质在非会员这里改成服务端会执行的那一档，避免界面写着 2K、发出去却是另一组像素。
  // 会员查询还没回来时不改，免得把会员的 4K 收掉。
  useEffect(() => {
    // 2.6 的 2K、高画质对所有人开放，4K 只是锁住，不把已存参数收成 2K。
    if (image26 || !premium.settled || activeView.codexCli || !capabilities.size) return
    const patch: Partial<TaskParams> = {}
    if (params.quality === 'high' && !premium.highQuality) patch.quality = 'medium'
    if (maxTier === '4K') {
      if (patch.quality !== undefined) setParams(patch)
      return
    }
    if (selection.kind === 'preset') {
      if (!tierFits(imageSizeTier(params.size), maxTier)) {
        const next = sizeFor(maxTier, selection.ratio, rules)
        if (next && next !== params.size) patch.size = next
      }
    } else if (selection.kind === 'custom') {
      const next = normalizeSizeFor(params.size, rules)
      if (next !== params.size) patch.size = next
    }
    if (patch.size !== undefined || patch.quality !== undefined) setParams(patch)
  }, [
    image26,
    premium.settled,
    premium.highQuality,
    activeView.codexCli,
    capabilities.size,
    maxTier,
    params.size,
    params.quality,
    selection,
    rules,
    setParams,
  ])
  const countVisible = showCount && !agentManaged
  const outputs = !isGemini && !agentManaged
  const transparentVisible =
    outputs && capabilities.transparentOutput && !unsupported?.has('transparent')
  const noRewriteVisible = outputs && !unsupported?.has('noRewrite')

  // 自定义：点了「自定义」但还没填出合法尺寸时，格子也要亮着。
  const [customOpen, setCustomOpen] = useState(false)
  const [clamped, setClamped] = useState(false)
  // 参考图只出静态图。动图和矢量留在界面上，置灰并写明原因。
  useEffect(() => {
    if (!editing || (params.output_format !== 'gif' && params.output_format !== 'svg')) return
    setParams({
      output_format: 'png',
      frame_count: undefined,
      frame_duration_ms: undefined,
    })
  }, [editing, params.output_format, setParams])
  // 自定义宽高失焦可能发生在格式已经切走之后，把 816 写回动图。帧尺寸只认 512 / 768。
  useEffect(() => {
    if (!image26 || params.output_format !== 'gif') return
    const size = gifFrameSize(params.size)
    if (params.size === size && params.quality === 'medium' && params.n === 1) return
    setParams({ size, quality: 'medium', n: 1 })
  }, [image26, params.output_format, params.size, params.quality, params.n, setParams])
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
  // 存着的档位这个模型不认（旧的 512、换模型前的 2K）时按最近一档显示，与提交时 BFF 的换法一致。
  const geminiImageSize = params.gemini_image_size
    ? nearestImageSize(params.gemini_image_size, capabilities.geminiImageSizes)
    : undefined
  const sizeSummary = isGemini
    ? [ratioLabel, tuning ? geminiImageSize : undefined]
    : selection.kind === 'custom'
      ? [capabilities.size ? params.size.replace('x', '×') : sizeRatioLabel(params.size)] // design-allow glyph-icon: 乘号
      : [ratioLabel, selection.kind === 'preset' && capabilities.size ? selection.tier : undefined]
  const summary = [
    ...(image26 && params.output_format === 'gif'
      ? [
          t('settings.gif'),
          params.frame_count ? t('settings.frames', { count: params.frame_count }) : '',
        ]
      : image26 && params.output_format === 'svg'
        ? [t('settings.svg')]
        : sizeSummary),
    countVisible && params.output_format !== 'gif' && params.output_format !== 'svg'
      ? t('settings.count', { count: fixedCount ?? params.n })
      : '',
  ]
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
    if (countVisible && fixedCount === undefined) patch.n = DEFAULT_PARAMS.n
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
    // 切到 GIF 会卸掉自定义宽高框，失焦回调还是切之前那次渲染。以最新写上的格式为准：
    // 全局模式读仓库，受控模式读每次渲染都更新的 ref（闭包里的 params 是旧的）。
    const liveFormat = controlled
      ? latestControlledFormat.current
      : useStore.getState().params.output_format
    if (liveFormat === 'gif' || liveFormat === 'svg') return
    const w = Number.parseInt(width, 10)
    const h = Number.parseInt(height, 10)
    if (!(w > 0 && h > 0)) return
    const next = normalizeSizeFor(`${w}x${h}`, rules)
    applySize(next, { custom: true, wasClamped: next !== `${w}x${h}` })
  }

  // 卡片关着时不调用：分组只在打开时构建。
  const renderSections = () => {
    const pixels = parseImageSize(params.size)
    const tierSize =
      selection.kind === 'preset' && capabilities.size
        ? sizeFor(selection.tier, selection.ratio, rules)
        : null
    const tierPixels = tierSize ? parseImageSize(tierSize) : pixels
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
            icon: <Icon name="resize" />,
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
        {!specialFormat && (
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
                  {/* design-allow glyph-icon: 宽高之间的乘号，不是图标 */}
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
                  value={selection.kind === 'auto' ? '' : selection.ratio}
                  onCommit={(draft) => {
                    const next = sizeFor('1K', draft, rules)
                    if (next) applySize(next, { custom: true })
                  }}
                />
              ))}
          </SettingsSection>
        )}

        {!specialFormat &&
          (isGemini
            ? tuning && (
                <SettingsSection title={t('param.resolution')}>
                  <SettingsSegmented
                    label={t('param.resolution')}
                    options={withAuto(capabilities.geminiImageSizes, t('settings.autoOption'))}
                    value={geminiImageSize ?? 'auto'}
                    onChange={(value) => setParams({ gemini_image_size: fromAuto(value) })}
                  />
                </SettingsSection>
              )
            : capabilities.size && (
                <SettingsSection
                  title={t('param.resolution')}
                  value={
                    image26
                      ? pixels
                        ? `${pixels.width} × ${pixels.height}`
                        : undefined
                      : tierPixels
                        ? `${tierPixels.width} × ${tierPixels.height}`
                        : undefined
                  }
                  hint={
                    premium.memberOnly
                      ? t('size.memberTierHint')
                      : selection.kind === 'auto'
                        ? t('settings.autoSizeHint')
                        : rules.maxTier === '1K'
                          ? t('size.limitedTierHint')
                          : undefined
                  }
                >
                  <SettingsSegmented
                    label={t('param.resolution')}
                    options={SIZE_TIERS.map((tier) => ({
                      value: tier,
                      label: tier,
                      disabled: image26
                        ? selection.kind === 'auto' || (tier === '4K' && !premium.member)
                        : selection.kind === 'auto' || !tierFits(tier, rules.maxTier),
                    }))}
                    value={selection.kind === 'preset' && !customOpen ? selection.tier : null}
                    onChange={(tier) => {
                      const next =
                        selection.kind === 'auto' ? null : sizeFor(tier, selection.ratio, rules)
                      if (next) applySize(next)
                    }}
                  />
                </SettingsSection>
              ))}

        {extra?.section}

        {countVisible && params.output_format !== 'gif' && params.output_format !== 'svg' && (
          <SettingsSection title={t('param.count')}>
            {fixedCount === undefined ? (
              <SettingsSegmented
                label={t('param.count')}
                options={countOptions.map((n) => ({ value: n, label: String(n) }))}
                value={params.n}
                onChange={(n) => setParams({ n })}
              />
            ) : (
              <p className="text-sm tabular-nums text-foreground">
                {t('settings.fixedCount', { count: fixedCount })}
              </p>
            )}
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

        {outputs && image26 && params.output_format === 'gif' && (
          <>
            <SettingsSection title={t('settings.framesLabel')}>
              <SettingsSegmented
                label={t('settings.framesLabel')}
                options={GPT_IMAGE_26_GIF_FRAMES.map((count) => ({
                  value: count,
                  label: String(count),
                }))}
                value={params.frame_count ?? 6}
                onChange={(frame_count) => setParams({ frame_count })}
              />
            </SettingsSection>
            <SettingsSection title={t('settings.durationLabel')}>
              <SettingsSegmented
                label={t('settings.durationLabel')}
                options={GPT_IMAGE_26_GIF_DURATIONS_MS.map((ms) => ({
                  value: ms,
                  label: t('settings.duration', { seconds: (ms / 1000).toFixed(1) }),
                }))}
                value={params.frame_duration_ms ?? 200}
                onChange={(frame_duration_ms) => setParams({ frame_duration_ms })}
              />
            </SettingsSection>
            <SettingsSection title={t('settings.gifSize')}>
              <SettingsSegmented
                label={t('settings.gifSize')}
                options={GPT_IMAGE_26_GIF_SIZES.map((size) => ({
                  value: size,
                  label: size.slice(0, size.indexOf('x')),
                }))}
                value={
                  params.size === '512x512' || params.size === '768x768' ? params.size : '768x768'
                }
                onChange={(size) => setParams({ size })}
              />
            </SettingsSection>
          </>
        )}
        {outputs &&
          capabilities.quality &&
          params.output_format !== 'gif' &&
          params.output_format !== 'svg' && (
            <SettingsSection
              title={t('param.quality')}
              hint={premium.memberOnly ? t('size.memberQualityHint') : undefined}
            >
              <SettingsSegmented
                label={t('param.quality')}
                options={[
                  { value: 'auto', label: t('settings.quality.auto') },
                  { value: 'low', label: t('settings.quality.low') },
                  { value: 'medium', label: t('settings.quality.medium') },
                  {
                    value: 'high',
                    label: t('settings.quality.high'),
                    disabled: !premium.highQuality,
                  },
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
              options={
                image26
                  ? [
                      { value: 'png' as const, label: t('settings.still') },
                      {
                        value: 'gif' as const,
                        label: (
                          <span className="inline-flex items-center justify-center gap-1">
                            {t('settings.gif')}
                            <Badge tone="primary" className="shrink-0 px-1">
                              {t('param.modelNew')}
                            </Badge>
                          </span>
                        ),
                        disabled: editing,
                      },
                      {
                        value: 'svg' as const,
                        label: (
                          <span className="inline-flex items-center justify-center gap-1">
                            {t('settings.svg')}
                            <Badge tone="primary" className="shrink-0 px-1">
                              {t('param.modelNew')}
                            </Badge>
                          </span>
                        ),
                        disabled: editing,
                      },
                    ]
                  : (['png', 'jpeg', 'webp'] as const).map((value) => ({
                      value,
                      label: FORMAT_LABELS[value],
                    }))
              }
              value={
                image26 && (params.output_format === 'jpeg' || params.output_format === 'webp')
                  ? 'png'
                  : params.output_format
              }
              onChange={(format) => {
                const next = switchImageOutputFormat(params, format, stillImage.current)
                stillImage.current = next.still
                setParams(next.patch)
              }}
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
      detail={extra?.detail}
      icon={
        <RatioShape
          ratio={selection.kind === 'custom' ? selection.ratio : ratio}
          className="h-3.5 w-3.5"
        />
      }
      badge={extra?.badge}
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
  fixedCount,
}: {
  showCount?: boolean
  agentManaged?: boolean
  size?: ComposerControlSize
  fixedCount?: number
}) {
  return (
    <>
      <ModelSelector size={size} />
      <ImageSettings
        showCount={showCount}
        agentManaged={agentManaged}
        size={size}
        fixedCount={fixedCount}
      />
    </>
  )
})

export default ParamControls
