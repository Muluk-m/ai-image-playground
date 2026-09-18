import { videoRateMultiplier } from '@image-playground/shared'
import { Film, ImageIcon, LayoutGrid, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { VideoIcon } from '../../../components/icons'
import SubmissionBillingAction from '../../../components/SubmissionBillingAction'
import { Button } from '../../../components/ui/button'
import { useTranslation } from '../../../i18n'
import { videoModelOptions } from '../../../lib/channels/videoChannels'
import { usePrivateSubmissionGuard } from '../../../lib/privateOverlay'
import { useStore } from '../../../store'
import CanvasVideoParams from '../../canvas/components/CanvasVideoParams'
import { useCanvasComposer } from '../../canvas/composerStore'
import { canvasVideoPromptRefusal } from '../../canvas/lib/submitVideoFromCanvas'
import { useInspirationStore } from '../../inspiration/store'
import { useLibraryStore } from '../../library/store'
import { useVideoStore } from '../store'

/** 工具箱每格都必须对应一个此刻真的能执行的动作，不摆点不动的卡片。 */
const TOOLS = [
  { id: 'fromImage', icon: ImageIcon, run: () => useLibraryStore.getState().openPanel('assets') },
  { id: 'references', icon: Film, run: () => useLibraryStore.getState().openPanel('assets') },
  { id: 'inspiration', icon: Sparkles, run: () => useInspirationStore.getState().openPanel() },
  { id: 'works', icon: LayoutGrid, run: () => useStore.getState().setAppMode('browse') },
] as const

/**
 * 视频入口的落地页：上半是一张大输入卡（创作类型、模型与档位、描述、生成），下半是工具箱与案例。
 * 它自己不发请求——提交只把这句话和视频档交给画布（`handOffVideoPrompt`），切过去挂载好再起轮，
 * 这样产物有画布可落。
 */
export default function VideoLanding() {
  const { t } = useTranslation(['video', 'common'])
  const [prompt, setPrompt] = useState('')
  const draft = useVideoStore((state) => state.draft)
  const items = useInspirationStore((state) => state.items)
  const options = videoModelOptions()

  useEffect(() => {
    useVideoStore.getState().syncModelOptions()
    void useInspirationStore.getState().loadRemote()
  }, [])

  const guard = usePrivateSubmissionGuard({
    model: draft.model,
    quantity: draft.duration,
    unitMultiplier: videoRateMultiplier(draft.model, draft.resolution),
  })
  const refusal = canvasVideoPromptRefusal(draft.model, prompt.trim())
  const canSubmit = prompt.trim().length > 0 && !refusal && !guard.blocked && options.length > 0

  // 案例带缩略图，取灵感库的前若干条；库还没读回来时不占位。
  const cases = useMemo(() => items.slice(0, 4), [items])

  const submit = () => {
    if (!canSubmit) return
    useCanvasComposer.getState().handOffVideoPrompt(prompt)
    useStore.getState().setAppMode('create')
  }

  return (
    <main className="safe-area-x mx-auto w-full max-w-5xl px-6 pb-24 pt-12">
      <h1 className="text-center text-3xl font-semibold tracking-tight">{t('landing.title')}</h1>
      <p className="mt-3 text-center text-sm text-muted-foreground">{t('landing.subtitle')}</p>

      <section
        aria-label={t('landing.composerAria')}
        className="mt-8 rounded-2xl border border-border bg-card p-4 shadow-sm"
      >
        <div
          className="flex w-max gap-1 rounded-xl bg-muted p-1"
          role="group"
          aria-label={t('landing.kindAria')}
        >
          <button
            type="button"
            aria-pressed={false}
            className="flex items-center gap-2 rounded-lg px-4 py-1.5 text-sm text-muted-foreground"
            onClick={() => useStore.getState().setAppMode('create')}
          >
            <ImageIcon className="h-4 w-4" /> {t('landing.kindImage')}
          </button>
          <button
            type="button"
            aria-pressed
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground"
          >
            <VideoIcon className="h-4 w-4" /> {t('landing.kindVideo')}
          </button>
        </div>

        {options.length > 0 ? (
          <div className="mt-3">
            <CanvasVideoParams hasFirstFrame={false} />
          </div>
        ) : (
          <p role="alert" className="mt-3 px-2 text-xs text-muted-foreground">
            {t('landing.noModel')}
          </p>
        )}

        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault()
              submit()
            }
          }}
          rows={4}
          aria-label={t('landing.promptAria')}
          placeholder={t('landing.promptPlaceholder')}
          className="mt-3 w-full resize-none rounded-xl bg-background px-3 py-2.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        />

        <SubmissionBillingAction blockedAction={guard.blockedAction} className="px-2 text-[11px]" />
        {refusal || (guard.blocked && guard.disabledReason) ? (
          <p className="px-2 text-[11px] text-destructive">{refusal ?? guard.disabledReason}</p>
        ) : null}
        <Button className="mt-3 w-full" disabled={!canSubmit} onClick={submit}>
          {t('landing.submit')}
        </Button>
      </section>

      <section className="mt-9" aria-label={t('landing.tools')}>
        <h2 className="mb-3 text-sm font-semibold">
          {t('landing.tools')}
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {t('landing.toolsHint')}
          </span>
        </h2>
        <ul className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
          {TOOLS.map((tool) => (
            <li key={tool.id}>
              <button
                type="button"
                onClick={tool.run}
                className="flex w-full items-center gap-3 rounded-xl border border-border bg-card p-3 text-left transition-colors hover:border-ring/60"
              >
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-accent">
                  <tool.icon className="h-4 w-4" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm">{t(`landing.tool.${tool.id}.title`)}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {t(`landing.tool.${tool.id}.hint`)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      {cases.length > 0 && (
        <section className="mt-9" aria-label={t('landing.cases')}>
          <h2 className="mb-3 text-sm font-semibold">
            {t('landing.cases')}
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {t('landing.casesHint')}
            </span>
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {cases.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => setPrompt(item.prompt)}
                  className="w-full overflow-hidden rounded-xl border border-border bg-card text-left transition-colors hover:border-ring/60"
                >
                  <img
                    src={item.thumbnailUrl}
                    alt=""
                    loading="lazy"
                    className="aspect-[4/3] w-full object-cover"
                  />
                  <span className="block px-3 pb-3 pt-2">
                    <span className="block text-[13px] font-semibold">{item.title}</span>
                    <span className="line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                      {item.description ?? item.prompt}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  )
}
