import { useMemo, useState } from 'react'
import { ReasoningEffort } from '../../../components/assistant-ui/elements/reasoning-effort'
import {
  type ModelChoice,
  ModelList,
  useModelChoices,
} from '../../../components/composer/ModelSelector'
import {
  RatioGrid,
  RatioShape,
  SettingsPopover,
  SettingsSection,
  SettingsSegmented,
  SettingsToggle,
} from '../../../components/composer/SettingsPanel'
import { ModelLogo } from '../../../components/ModelIdentity'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import { clientProfileToApiProfile, getActiveApiProfile } from '../../../lib/apiProfiles'
import { getParamCapabilities } from '../../../lib/paramCompatibility'
import { readSizeSelection, sizeFor } from '../../../lib/size'
import { useStore } from '../../../store'
import { DEFAULT_PARAMS } from '../../../types'
import { IMAGE_COUNT_CHOICES, snapImageCount } from '../lib/turnParams'
import { useAgentStore } from '../store'
import { ThinkingDepthMark } from './ThinkingDepthMark'

const DEPTHS = ['fast', 'medium', 'deep'] as const
const AUTO_MODEL = 'auto-model'
const AGENT_RATIOS = ['auto', '1:1', '3:4', '4:3', '16:9'] as const
const IMAGE_RATIOS = ['1:1', '3:4', '4:3', '16:9', '9:16'] as const

function depthLevels(labels: Record<(typeof DEPTHS)[number], string>) {
  return DEPTHS.map((key) => ({
    key,
    label: (
      <span className="inline-flex items-center justify-center gap-1.5">
        <ThinkingDepthMark depth={key} />
        {labels[key]}
      </span>
    ),
  }))
}

/** Execution controls remain visible for video turns as well as image turns. */
export function AgentExecutionSettings() {
  const { t } = useTranslation('agent')
  const depth = useAgentStore((state) => state.thinkingDepth)
  const autoSubmit = useAgentStore((state) => state.autoSubmit)
  const labels = {
    fast: t('params.thinkingFast'),
    medium: t('params.thinkingMedium'),
    deep: t('params.thinkingDeep'),
  }
  return (
    <>
      <SettingsSection title={t('params.thinkingLegend')}>
        <ReasoningEffort
          label={t('params.thinkingLegend')}
          levels={depthLevels(labels)}
          selectedKey={depth}
          onSelect={(key) => {
            if (key === 'fast' || key === 'medium' || key === 'deep')
              useAgentStore.getState().setThinkingDepth(key)
          }}
        />
      </SettingsSection>
      <SettingsToggle
        label={t('params.autoSubmitLabel')}
        description={t('params.autoSubmitHint')}
        checked={autoSubmit}
        onChange={(value) => useAgentStore.getState().setAutoSubmit(value)}
      />
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
  const rules = { ratioOnly: !capabilities.size, limitTo1K: view.codexCli }
  const selection = useMemo(
    () => readSizeSelection(params.size, rules),
    [params.size, rules.ratioOnly, rules.limitTo1K],
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

/**
 * 模型、画幅、思考深度和张数收进同一颗胶囊。
 * 智能体模式不选张数；图片生成模式才给出 1/2/3/4/6/8。
 * 制作模式只留思考深度。
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
  const setModelAuto = useAgentStore((state) => state.setModelAuto)
  const { options, currentValue, current, pick } = useModelChoices()
  const { ratio, setRatio } = useComposerRatio()
  const count = snapImageCount(useStore((state) => state.params.n))
  const [modelsOpen, setModelsOpen] = useState(false)
  const labels = {
    fast: t('params.thinkingFast'),
    medium: t('params.thinkingMedium'),
    deep: t('params.thinkingDeep'),
  }
  const showThinking = thinkingControls && !imageMode
  const showAutoModel = !imageMode && modelAuto
  const modelLabel = showAutoModel
    ? t('params.modelAuto')
    : (current?.label ?? t('params.modelAuto'))
  const modelIcon = showAutoModel ? (
    <Icon name="model" />
  ) : (
    <ModelLogo model={current?.model ?? ''} />
  )
  const ratioLabel = ratio === 'auto' ? t('composer:settings.autoOption') : ratio
  const summaryParts = [
    modelLabel,
    showThinking ? labels[depth] : '',
    ratio !== 'auto' ? ratio : '',
    imageMode ? t('composer:settings.count', { count }) : '',
  ].filter(Boolean)
  const summary = summaryParts.join(' · ')
  const ratioChoices = (imageMode ? IMAGE_RATIOS : AGENT_RATIOS) as readonly string[]
  const ratios = ratioChoices.includes(ratio) ? ratioChoices : [ratio, ...ratioChoices]

  const thinking = (
    <SettingsSection title={t('params.thinkingLegend')}>
      <ReasoningEffort
        label={t('params.thinkingLegend')}
        levels={depthLevels(labels)}
        selectedKey={depth}
        onSelect={(key) => {
          if (key === 'fast' || key === 'medium' || key === 'deep') setDepth(key)
        }}
      />
    </SettingsSection>
  )

  if (!generationControls) {
    return (
      <SettingsPopover
        size="md"
        summary={t('params.thinkingSummary', { label: labels[depth] })}
        icon={<ThinkingDepthMark depth={depth} />}
        title={t('params.thinkingLegend')}
        dirty={depth !== 'medium'}
        onReset={() => setDepth('medium')}
      >
        {() => thinking}
      </SettingsPopover>
    )
  }

  const modelOptions: ModelChoice[] = imageMode
    ? [...options]
    : [
        {
          value: AUTO_MODEL,
          model: 'auto',
          profileId: '',
          label: t('params.modelAutoOption'),
          description: t('params.modelAuto'),
        },
        ...options,
      ]
  const modelValue = showAutoModel ? AUTO_MODEL : currentValue

  return (
    <SettingsPopover
      size="md"
      className="creation-params-capsule"
      summary={summary}
      title={t('composer:settings.title')}
      dirty={false}
      onReset={() => {
        setRatio('auto')
        if (showThinking) setDepth('medium')
        if (!imageMode) setModelAuto(true)
        if (imageMode) useStore.getState().setParams({ n: DEFAULT_PARAMS.n })
      }}
      summaryContent={
        <span className="creation-params-segments">
          <span className="flex shrink-0">{modelIcon}</span>
          <span className="creation-params-text">{modelLabel}</span>
          {showThinking && (
            <>
              <span className="creation-params-text" aria-hidden="true">
                ·
              </span>
              <ThinkingDepthMark depth={depth} />
              <span className="creation-params-text">{labels[depth]}</span>
            </>
          )}
          {ratio !== 'auto' && (
            <>
              <span className="creation-params-text" aria-hidden="true">
                ·
              </span>
              <RatioShape ratio={ratio} />
              <span className="creation-params-text">{ratio}</span>
            </>
          )}
          {imageMode && (
            <>
              <span className="creation-params-text" aria-hidden="true">
                ·
              </span>
              <span className="creation-params-mark">{count}</span>
              <span className="creation-params-text">{t('params.countUnit')}</span>
            </>
          )}
        </span>
      }
    >
      {() => (
        <>
          <SettingsSection title={t('params.model')}>
            <Button
              type="button"
              variant="outline"
              className="h-10 w-full justify-between rounded-xl px-3 font-normal"
              aria-expanded={modelsOpen}
              aria-label={t('params.model')}
              onClick={() => setModelsOpen((open) => !open)}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="flex shrink-0">{modelIcon}</span>
                <span className="truncate">
                  {showAutoModel ? t('params.modelAutoOption') : modelLabel}
                </span>
              </span>
              <Icon name="chevronDown" />
            </Button>
            {modelsOpen && (
              <ModelList
                options={modelOptions}
                value={modelValue}
                onPick={(value) => {
                  if (value === AUTO_MODEL) setModelAuto(true)
                  else {
                    setModelAuto(false)
                    pick(value)
                  }
                  setModelsOpen(false)
                }}
              />
            )}
          </SettingsSection>
          <SettingsSection title={t('params.ratio')}>
            <RatioGrid
              label={t('params.ratio')}
              options={ratios.map((value) => ({
                value,
                label: value === 'auto' ? t('composer:settings.autoOption') : value,
              }))}
              value={ratio}
              onChange={setRatio}
            />
          </SettingsSection>
          {showThinking && thinking}
          {imageMode ? (
            <SettingsSection title={t('params.outputCount')}>
              <SettingsSegmented
                label={t('params.outputCount')}
                options={IMAGE_COUNT_CHOICES.map((value) => ({
                  value,
                  label: String(value),
                }))}
                value={count}
                onChange={(next) => useStore.getState().setParams({ n: next })}
              />
            </SettingsSection>
          ) : (
            <>
              <SettingsToggle
                label={t('params.autoSubmitLabel')}
                description={t('params.autoSubmitHint')}
                checked={autoSubmit}
                onChange={(value) => useAgentStore.getState().setAutoSubmit(value)}
              />
            </>
          )}
        </>
      )}
    </SettingsPopover>
  )
}
