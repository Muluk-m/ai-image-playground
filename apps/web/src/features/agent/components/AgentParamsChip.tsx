import { Zap } from 'lucide-react'
import { useMemo } from 'react'
import { ReasoningEffort } from '../../../components/assistant-ui/elements/reasoning-effort'
import { ModelSelector } from '../../../components/composer/ModelSelector'
import {
  SettingsPopover,
  SettingsSection,
  SettingsToggle,
} from '../../../components/composer/SettingsPanel'
import { ImageSettings, type UnsupportedParam } from '../../../components/ParamControls'
import { useTranslation } from '../../../i18n'
import { getActiveApiProfile } from '../../../lib/apiProfiles'
import { useStore } from '../../../store'
import { useAgentStore } from '../store'

/**
 * 智能体这条路做不到的两项，开关不出现。理由见 `lib/turnParams.ts`：
 * 透明是浏览器里的抠色流水线，防改写是给提示词加前缀而提示词由模型在服务端写。
 */
const UNSUPPORTED: ReadonlySet<UnsupportedParam> = new Set(['transparent', 'noRewrite'])

const DEPTHS = ['fast', 'medium', 'deep'] as const

/**
 * 模型独立快选；画幅、思考深度与出图模式收进参数卡片，摘要只写画幅。
 * 张数由智能体按需求决定，所以没有数量。
 *
 * 自带 Key 的配置在智能体这条路上不生效——服务端没有 BYOK 分支，模型一律从内置渠道里挑。
 * 所以 BYOK 时 chip 不写 profile 里那个模型名，卡片底部写明原因。
 *
 * 制作模式下生成参数跟着每份草稿走（`generationControls={false}`），这里只留思考深度。
 */
export default function AgentParamsChip({
  generationControls = true,
}: {
  generationControls?: boolean
}) {
  const { t } = useTranslation(['agent', 'composer'])
  const autoSubmit = useAgentStore((state) => state.autoSubmit)
  const depth = useAgentStore((state) => state.thinkingDepth)
  const setDepth = useAgentStore((state) => state.setThinkingDepth)
  const settings = useStore((state) => state.settings)
  const byok = useMemo(() => getActiveApiProfile(settings).source === 'user-byok', [settings])
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
        size="sm"
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
      <ModelSelector size="sm" label={byok ? t('params.builtinModel') : undefined} />
      <ImageSettings
        size="sm"
        unsupported={UNSUPPORTED}
        extra={{
          dirty: depth !== 'medium',
          reset: () => setDepth('medium'),
          badge: autoSubmit ? (
            <Zap aria-label={t('params.autoSubmitLabel')} className="h-3.5 w-3.5 text-primary" />
          ) : undefined,
          section: (
            <>
              {thinking}
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
              {byok && <p>{t('params.byokNote')}</p>}
            </div>
          ),
        }}
      />
    </>
  )
}
