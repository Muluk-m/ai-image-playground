import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDownIcon, SettingsIcon } from '../../../components/icons'
import { compactModelName } from '../../../components/ModelIdentity'
import ParamControls, { type UnsupportedParam } from '../../../components/ParamControls'
import { Button } from '../../../components/ui/button'
import { useCloseOnEscape } from '../../../hooks/useCloseOnEscape'
import { useTranslation } from '../../../i18n'
import { clientProfileToApiProfile, getActiveApiProfile } from '../../../lib/apiProfiles'
import { getParamCapabilities } from '../../../lib/paramCompatibility'
import { normalizeImageSize, sizeRatioLabel } from '../../../lib/size'
import { useStore } from '../../../store'
import { INK, INK_3, PANEL_SHADOW, PANEL_SURFACE } from '../agentStyles'
import { useAgentStore } from '../store'

/**
 * 智能体这条路做不到的两项，chip 不出现。理由见 `lib/turnParams.ts`：
 * 透明是浏览器里的抠色流水线，防改写是给提示词加前缀而提示词由模型在服务端写。
 */
const UNSUPPORTED: ReadonlySet<UnsupportedParam> = new Set(['transparent', 'noRewrite'])

/**
 * 收起时只给一行摘要：当前打哪个模型、出多大。张数由智能体按需求决定。
 *
 * 自带 Key 的配置在智能体这条路上不生效——服务端没有 BYOK 分支，模型一律从内置渠道里挑。
 * 所以 BYOK 时不摆 profile 里那个模型名：那是「界面写 A、实际花钱跑 B」。真正用上的那一个
 * 由服务端冻结进草稿，卡片上那行写的就是它。
 */
function useSummary(): { readonly parts: string[]; readonly byok: boolean } {
  const { t } = useTranslation('agent')
  const params = useStore((state) => state.params)
  const settings = useStore((state) => state.settings)
  return useMemo(() => {
    const active = getActiveApiProfile(settings)
    const profile = clientProfileToApiProfile(active)
    const capabilities = getParamCapabilities(active, params.output_format)
    const byok = active.source === 'user-byok'
    const parts = [byok ? t('params.builtinModel') : compactModelName(profile.model, profile.model)]
    parts.push(
      profile.provider === 'gemini'
        ? params.gemini_aspect_ratio || t('params.autoRatio')
        : params.size && params.size !== 'auto'
          ? capabilities.size
            ? normalizeImageSize(params.size)
            : sizeRatioLabel(params.size)
          : capabilities.size
            ? t('params.autoSize')
            : t('params.autoRatio'),
    )
    return { parts, byok }
  }, [params, settings, t])
}

export default function AgentParamsChip() {
  const { t } = useTranslation('agent')
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const generation = useSummary()
  const depth = useAgentStore((state) => state.thinkingDepth)
  const setDepth = useAgentStore((state) => state.setThinkingDepth)
  const labels = {
    fast: t('params.thinkingFast'),
    medium: t('params.thinkingMedium'),
    deep: t('params.thinkingDeep'),
  }
  const summary = [t('params.thinkingSummary', { label: labels[depth] }), ...generation.parts]
  const insidePointerRef = useRef<Event | null>(null)
  useCloseOnEscape(open, () => setOpen(false))

  // 点到面板外面就收起来；浮层盖在画布上，不收起会一直挡着。
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (insidePointerRef.current === event) return
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [open])

  return (
    <div
      ref={wrapperRef}
      className="min-w-0"
      onPointerDownCapture={(event) => {
        // React capture includes child portals, unlike DOM contains().
        insidePointerRef.current = event.nativeEvent
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label={t('params.title')}
        className={`flex min-w-0 max-w-full items-center h-8 gap-1.5 rounded-full bg-muted px-2.5 text-[11px] transition-colors hover:bg-muted ${INK_3}`}
        onClick={() => setOpen((was) => !was)}
      >
        <SettingsIcon aria-hidden="true" className="h-3 w-3 shrink-0" />
        <span className="truncate" title={summary.join(' · ')}>
          {summary.join(' · ')}
        </span>
        <ChevronDownIcon aria-hidden="true" className="h-3 w-3 shrink-0" />
      </button>

      {open && (
        <div
          className={`studio-agent-params absolute bottom-full right-0 z-10 mb-2 w-[19rem] max-w-[calc(100vw-2rem)] rounded-xl p-3 ${PANEL_SURFACE} ${PANEL_SHADOW}`}
        >
          <div className="mb-2 flex items-center justify-between">
            <p className={`text-xs font-semibold ${INK}`}>{t('params.title')}</p>
            <button
              type="button"
              aria-label={t('params.closeAria')}
              onClick={() => setOpen(false)}
              className="rounded-lg px-3 py-2 text-sm text-muted-foreground"
            >
              {t('params.done')}
            </button>
          </div>
          <fieldset className="mb-3">
            <legend className={`mb-2 text-xs font-semibold ${INK}`}>
              {t('params.thinkingLegend')}
            </legend>
            <div className="flex gap-1">
              {(['fast', 'medium', 'deep'] as const).map((value) => (
                <Button
                  type="button"
                  key={value}
                  aria-pressed={depth === value}
                  onClick={() => setDepth(value)}
                  size="sm"
                  variant={depth === value ? 'default' : 'secondary'}
                  className="flex-1"
                >
                  {labels[value]}
                </Button>
              ))}
            </div>
          </fieldset>
          <div className="flex flex-wrap items-center gap-1.5">
            <ParamControls unsupported={UNSUPPORTED} />
          </div>
          <p className={`mt-2 text-[11px] leading-relaxed ${INK_3}`}>{t('params.note')}</p>
          {generation.byok && (
            <p className={`mt-2 text-[11px] leading-relaxed ${INK_3}`}>{t('params.byokNote')}</p>
          )}
        </div>
      )}
    </div>
  )
}
