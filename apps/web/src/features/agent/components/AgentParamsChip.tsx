import { agentModelImageMax, isGptDirectModel } from '@image-playground/shared'
import { Fragment, type ReactNode, useMemo, useRef, useState } from 'react'
import { ModelList, useModelChoices } from '../../../components/composer/ModelSelector'
import {
  RatioGrid,
  SettingsLinkRow,
  SettingsPopover,
  SettingsSection,
  SettingsSegmented,
  SettingsSubpage,
  SettingsToggle,
} from '../../../components/composer/SettingsPanel'
import { ModelLogo } from '../../../components/ModelIdentity'
import { useTranslation } from '../../../i18n'
import { clientProfileToApiProfile, getActiveApiProfile } from '../../../lib/apiProfiles'
import { useGptPremiumLocked } from '../../../lib/gptPremium'
import { getParamCapabilities } from '../../../lib/paramCompatibility'
import { readSizeSelection, type SizeTier, sizeFor } from '../../../lib/size'
import { useStore } from '../../../store'
import { DEFAULT_PARAMS } from '../../../types'
import { imageCountChoices, snapImageCount } from '../lib/turnParams'
import { useAgentStore } from '../store'
import { ThinkingDepthMark } from './ThinkingDepthMark'

const DEPTHS = ['fast', 'medium', 'deep'] as const
const AGENT_RATIOS = ['auto', '1:1', '3:4', '4:3', '16:9'] as const
const IMAGE_RATIOS = ['1:1', '3:4', '4:3', '16:9', '9:16'] as const

function useDepthLabels() {
  const { t } = useTranslation('agent')
  return {
    fast: t('params.thinkingFast'),
    medium: t('params.thinkingMedium'),
    deep: t('params.thinkingDeep'),
  }
}

function SpeedSection() {
  const { t } = useTranslation('agent')
  const labels = useDepthLabels()
  const depth = useAgentStore((state) => state.thinkingDepth)
  return (
    <SettingsSection title={t('params.thinkingLegend')}>
      <SettingsSegmented
        label={t('params.thinkingLegend')}
        options={DEPTHS.map((key) => ({ value: key, label: labels[key] }))}
        value={depth}
        onChange={(key) => useAgentStore.getState().setThinkingDepth(key)}
      />
    </SettingsSection>
  )
}

function ConfirmToggle() {
  const { t } = useTranslation('agent')
  const autoSubmit = useAgentStore((state) => state.autoSubmit)
  return (
    <SettingsToggle
      label={t('params.confirmBeforeGenerate')}
      checked={!autoSubmit}
      onChange={(confirm) => useAgentStore.getState().setAutoSubmit(!confirm)}
    />
  )
}

/** Execution controls remain visible for video turns as well as image turns. */
export function AgentExecutionSettings() {
  return (
    <>
      <SpeedSection />
      <ConfirmToggle />
    </>
  )
}

function useComposerRatio() {
  const params = useStore((state) => state.params)
  const setParams = useStore((state) => state.setParams)
  const settings = useStore((state) => state.settings)
  const active = useMemo(() => getActiveApiProfile(settings), [settings])
  const view = clientProfileToApiProfile(active)
  const isGemini = view.provider === 'gemini'
  const capabilities = getParamCapabilities(active, params.output_format)
  const premium = useGptPremiumLocked(view.model, capabilities.size)
  // 智能体这条路的 GPT 直连收到非会员上限（≤2K），不跟创作页会员的 4K 走。Codex CLI 仍是 1K。
  const maxTier: SizeTier = view.codexCli
    ? '1K'
    : isGptDirectModel(view.model)
      ? premium.maxTier === '4K'
        ? '2K'
        : premium.maxTier
      : premium.maxTier
  const rules = {
    ratioOnly: !capabilities.size,
    maxTier,
  }
  const selection = useMemo(
    () => readSizeSelection(params.size, rules),
    [params.size, rules.ratioOnly, rules.maxTier],
  )
  const ratio = isGemini
    ? (params.gemini_aspect_ratio ?? 'auto')
    : selection.kind === 'auto'
      ? 'auto'
      : selection.ratio
  const setRatio = (value: string) => {
    if (isGemini) {
      setParams({
        gemini_aspect_ratio:
          value === 'auto' ? undefined : (value as NonNullable<typeof params.gemini_aspect_ratio>),
      })
      return
    }
    if (value === 'auto') {
      setParams({ size: 'auto' })
      return
    }
    const tier = selection.kind === 'preset' ? selection.tier : '1K'
    const next = sizeFor(tier, value, rules)
    if (next) setParams({ size: next })
  }
  return { ratio, setRatio }
}

interface Segment {
  key: string
  label: string
  /** 偏离默认、写在胶囊上。 */
  shown: boolean
  /** 读屏与悬停的完整摘要里要不要它；缺省同 `shown`。 */
  described?: boolean
  /** 缺省可被收起、不被截断；模型名可截断，张数在窄输入框里也留着。 */
  className?: string
  icon?: ReactNode
}

const SEGMENT_TEXT = 'creation-params-text shrink-0'
const MODEL_TEXT = 'creation-params-text creation-params-model'

/** 胶囊上的几段文字，中间用圆点隔开；窄输入框里文字收起（creation.css）。 */
function CapsuleSegments({ segments }: { segments: readonly Segment[] }) {
  return (
    <span className="creation-params-segments">
      {segments.map((segment, index) => (
        <Fragment key={segment.key}>
          {index > 0 && (
            <span className={SEGMENT_TEXT} aria-hidden="true">
              ·
            </span>
          )}
          {segment.icon}
          <span className={segment.className ?? SEGMENT_TEXT}>{segment.label}</span>
        </Fragment>
      ))}
    </span>
  )
}

/** 卡片内容：关着时整块卸载，二级页状态随之回到主页。 */
function AgentSettingsCard({
  imageMode,
  showThinking,
  ratio,
  ratios,
  onRatio,
  count,
  countChoices,
  modelValue,
}: {
  imageMode: boolean
  showThinking: boolean
  ratio: string
  ratios: readonly string[]
  onRatio: (value: string) => void
  count: number
  countChoices: readonly number[]
  modelValue: string
}) {
  const { t } = useTranslation(['agent', 'composer'])
  const modelAuto = useAgentStore((state) => state.modelAuto)
  const setModelAuto = useAgentStore((state) => state.setModelAuto)
  const { options, currentValue, pick } = useModelChoices()
  const [page, setPage] = useState<'main' | 'model'>('main')
  const modelRowRef = useRef<HTMLButtonElement>(null)

  if (page === 'model') {
    return (
      <SettingsSubpage
        title={t('params.model')}
        onBack={() => setPage('main')}
        returnFocusRef={modelRowRef}
      >
        {!imageMode && (
          <SettingsToggle
            label={t('params.modelAutoToggle')}
            checked={modelAuto}
            onChange={setModelAuto}
          />
        )}
        {(imageMode || !modelAuto) && (
          <ModelList
            options={options}
            value={currentValue}
            onPick={(value) => {
              pick(value)
              // 切到单笔上限更低的模型（Lite 一单 4 张）：已选的 6、8 张随之落到能出的那一档。
              const model = options.find((option) => option.value === value)?.model
              const chosen = useStore.getState().params.n
              if (imageMode && chosen > agentModelImageMax(model))
                useStore.getState().setParams({ n: snapImageCount(chosen, model) })
              setPage('main')
            }}
          />
        )}
      </SettingsSubpage>
    )
  }
  return (
    <>
      <SettingsSection title={t('params.ratio')}>
        <RatioGrid
          label={t('params.ratio')}
          options={ratios.map((value) => ({
            value,
            label: value === 'auto' ? t('composer:settings.autoOption') : value,
          }))}
          value={ratio}
          onChange={onRatio}
        />
      </SettingsSection>
      {showThinking && <SpeedSection />}
      {imageMode ? (
        <SettingsSection title={t('params.outputCount')}>
          <SettingsSegmented
            label={t('params.outputCount')}
            options={countChoices.map((value) => ({ value, label: String(value) }))}
            value={count}
            onChange={(next) => useStore.getState().setParams({ n: next })}
          />
        </SettingsSection>
      ) : (
        <ConfirmToggle />
      )}
      <SettingsLinkRow
        ref={modelRowRef}
        label={t('params.model')}
        value={modelValue}
        onClick={() => setPage('model')}
      />
    </>
  )
}

/**
 * 智能体模式的胶囊：用户只设 Agent 猜不到的偏好（画幅、速度、出图前确认），模型默认交给 Agent。
 * 胶囊只写偏离默认的那几项。图片生成模式改为模型 · 比例 · 张数；制作模式只留速度。
 */
export default function AgentParamsChip({
  generationControls = true,
  thinkingControls = true,
  imageMode = false,
}: {
  generationControls?: boolean
  thinkingControls?: boolean
  imageMode?: boolean
}) {
  const { t } = useTranslation(['agent', 'composer'])
  const depth = useAgentStore((state) => state.thinkingDepth)
  const setDepth = useAgentStore((state) => state.setThinkingDepth)
  const autoSubmit = useAgentStore((state) => state.autoSubmit)
  const modelAuto = useAgentStore((state) => state.modelAuto)
  const { current } = useModelChoices()
  const { ratio, setRatio } = useComposerRatio()
  const storedCount = useStore((state) => state.params.n)
  const labels = useDepthLabels()

  if (!generationControls) {
    return (
      <SettingsPopover
        size="md"
        summary={t('params.thinkingSummary', { label: labels[depth] })}
        icon={<ThinkingDepthMark depth={depth} />}
        title={t('params.thinkingLegend')}
        onReset={depth !== 'medium' ? () => setDepth('medium') : undefined}
      >
        {() => <SpeedSection />}
      </SettingsPopover>
    )
  }

  const countModel = imageMode ? current?.model : undefined
  const count = snapImageCount(storedCount, countModel)
  const showThinking = thinkingControls && !imageMode
  const showAutoModel = !imageMode && modelAuto
  const modelLabel = showAutoModel
    ? t('params.modelAuto')
    : (current?.label ?? t('params.modelAuto'))
  const ratioSegment: Segment = { key: 'ratio', label: ratio, shown: ratio !== 'auto' }
  const segments: Segment[] = imageMode
    ? [
        {
          key: 'model',
          label: modelLabel,
          shown: true,
          className: MODEL_TEXT,
          icon: (
            <span className="flex shrink-0">
              <ModelLogo model={current?.model ?? ''} />
            </span>
          ),
        },
        ratioSegment,
        {
          key: 'count',
          label: t('composer:settings.count', { count }),
          shown: true,
          // 张数关系到扣费，窄输入框收起文字时也留着。
          className: 'shrink-0 tabular-nums',
        },
      ]
    : [
        {
          key: 'model',
          label: modelLabel,
          shown: !showAutoModel,
          described: true,
          className: MODEL_TEXT,
        },
        {
          key: 'depth',
          label: labels[depth],
          shown: showThinking && depth !== 'medium',
          described: showThinking,
        },
        ratioSegment,
        { key: 'confirm', label: t('params.confirmShort'), shown: !autoSubmit },
      ]
  const summary = segments
    .filter((segment) => segment.described ?? segment.shown)
    .map((segment) => segment.label)
    .join(' · ')
  const visible = segments.filter((segment) => segment.shown)
  // 智能体模式里胶囊上写出来的就是改过的那几项。
  const changed = imageMode ? ratio !== 'auto' || count !== DEFAULT_PARAMS.n : visible.length > 0
  const ratioChoices = (imageMode ? IMAGE_RATIOS : AGENT_RATIOS) as readonly string[]

  return (
    <SettingsPopover
      size="md"
      className="creation-params-capsule"
      summary={summary}
      title={t('composer:settings.title')}
      dirty={!imageMode && changed}
      onReset={
        changed
          ? () => {
              setRatio('auto')
              if (imageMode) useStore.getState().setParams({ n: DEFAULT_PARAMS.n })
              else {
                useAgentStore.getState().setModelAuto(true)
                useAgentStore.getState().setAutoSubmit(true)
                if (showThinking) setDepth('medium')
              }
            }
          : undefined
      }
      summaryContent={visible.length > 0 ? <CapsuleSegments segments={visible} /> : ''}
    >
      {() => (
        <AgentSettingsCard
          imageMode={imageMode}
          showThinking={showThinking}
          ratio={ratio}
          ratios={ratioChoices.includes(ratio) ? ratioChoices : [ratio, ...ratioChoices]}
          onRatio={setRatio}
          count={count}
          countChoices={imageCountChoices(countModel)}
          modelValue={showAutoModel ? t('composer:settings.autoOption') : modelLabel}
        />
      )}
    </SettingsPopover>
  )
}
