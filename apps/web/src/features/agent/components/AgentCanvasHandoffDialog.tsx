import { useEffect, useRef, useState } from 'react'
import Overlay from '../../../components/patterns/Overlay'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import {
  type CanvasProject,
  projectEntryName,
  projectExperience,
} from '../../canvas/lib/projectRepository'

export default function AgentCanvasHandoffDialog({
  count,
  projects,
  onChoose,
  onClose,
}: {
  count: number
  projects: readonly CanvasProject[]
  onChoose: (id?: string) => Promise<boolean>
  onClose: () => void
}) {
  const { t } = useTranslation('agent')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const first = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    first.current?.focus()
  }, [busy, onClose])
  const choose = async (id?: string) => {
    if (busy) return
    setBusy(true)
    setFailed(false)
    try {
      if (!(await onChoose(id))) setFailed(true)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  const canvases = projects.filter(
    (project) => projectExperience(project) === 'canvas' && !project.cloud?.deleted,
  )
  return (
    <Overlay
      onClose={() => {
        if (!busy) onClose()
      }}
      role="none"
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={t('handoff.title')}
        className="flex max-h-[90dvh] w-full max-w-md flex-col overflow-hidden rounded-3xl bg-card p-6 shadow-dialog ring-1 ring-hairline"
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-xl font-semibold">{t('handoff.title')}</h2>
          <Button
            variant="ghost"
            size="icon-sm"
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label={t('handoff.close')}
          >
            <Icon name="close" />
          </Button>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">{t('handoff.description', { count })}</p>
        <Button
          ref={first}
          type="button"
          disabled={busy}
          onClick={() => void choose()}
          className="w-full justify-start"
        >
          <Icon name="add" />
          <span className="flex-1 text-left">{t('handoff.new')}</span>
          <Icon name="arrowRight" />
        </Button>
        <p className="mt-1.5 text-xs text-muted-foreground">{t('handoff.newHint')}</p>
        {canvases.length > 0 && (
          <>
            <div className="mb-2 mt-5 text-xs text-muted-foreground">{t('handoff.existing')}</div>
            <div className="min-h-0 space-y-2 overflow-y-auto">
              {canvases.map((project) => (
                <Button
                  variant="outline"
                  type="button"
                  className="w-full justify-start"
                  key={project.id}
                  disabled={busy}
                  onClick={() => void choose(project.id)}
                >
                  <Icon name="canvas" />
                  <span className="min-w-0 flex-1 truncate text-left">
                    {projectEntryName(project)}
                  </span>
                  <Icon name="arrowRight" />
                </Button>
              ))}
            </div>
          </>
        )}
        {failed && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {t('handoff.failed')}
          </p>
        )}
      </section>
    </Overlay>
  )
}
