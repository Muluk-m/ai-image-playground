import { ReasoningEffort } from '../../../components/assistant-ui/elements/reasoning-effort'
import { ModelSelector } from '../../../components/composer/ModelSelector'
import {
  SettingsPopover,
  SettingsSection,
  SettingsToggle,
} from '../../../components/composer/SettingsPanel'
import { ImageSettings, type UnsupportedParam } from '../../../components/ParamControls'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import { useAgentStore } from '../store'

/**
 * 智能体这条路做不到的两项，开关不出现。理由见 `lib/turnParams.ts`：
 * 透明是浏览器里的抠色流水线，防改写是给提示词加前缀而提示词由模型在服务端写。
 */
const UNSUPPORTED: ReadonlySet<UnsupportedParam> = new Set(['transparent', 'noRewrite'])

const DEPTHS = ['fast', 'medium', 'deep'] as const

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
          levels={DEPTHS.map((key) => ({ key, label: labels[key] }))}
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

/**
 * 模型独立快选；画幅、思考深度与出图模式收进参数卡片，摘要只写画幅。
 * 张数由智能体按需求决定，所以没有数量。
 *
 * 制作模式下生成参数跟着每份草稿走（`generationControls={false}`），这里只留思考深度。
 */
export default function AgentParamsChip({
  generationControls = true,
  thinkingControls = true,
}: {
  generationControls?: boolean
  thinkingControls?: boolean
}) {
  const { t } = useTranslation(['agent', 'composer'])
  const autoSubmit = useAgentStore((state) => state.autoSubmit)
  const depth = useAgentStore((state) => state.thinkingDepth)
  const setDepth = useAgentStore((state) => state.setThinkingDepth)
  const labels = {
    fast: t('params.thinkingFast'),
    medium: t('params.thinkingMedium'),
    deep: t('params.thinkingDeep'),
  }

  const thinking = (
    <SettingsSection title={t('params.thinkingLegend')}>
      <ReasoningEffort
        label={t('params.thinkingLegend')}
        levels={DEPTHS.map((key) => ({ key, label: labels[key] }))}
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
        title={t('params.thinkingLegend')}
        dirty={depth !== 'medium'}
        onReset={() => setDepth('medium')}
      >
        {() => thinking}
      </SettingsPopover>
    )
  }

  return (
    <>
      <ModelSelector size="md" />
      <ImageSettings
        size="md"
        unsupported={UNSUPPORTED}
        extra={{
          dirty: thinkingControls && depth !== 'medium',
          reset: () => {
            if (thinkingControls) setDepth('medium')
          },
          badge: autoSubmit ? (
            <Icon
              name="speed"
              size="xs"
              label={t('params.autoSubmitLabel')}
              className="text-primary"
            />
          ) : undefined,
          section: (
            <>
              {thinkingControls && thinking}
              <SettingsToggle
                label={t('params.autoSubmitLabel')}
                description={t('params.autoSubmitHint')}
                checked={autoSubmit}
                onChange={(value) => useAgentStore.getState().setAutoSubmit(value)}
              />
            </>
          ),
          footnote: (
            <div className="space-y-1.5 text-label-sm leading-relaxed text-muted-foreground">
              <p>{t('params.note')}</p>
            </div>
          ),
        }}
      />
    </>
  )
}
