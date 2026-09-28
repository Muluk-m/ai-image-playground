import { ArrowRight, Images, LayoutDashboard, Plus, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from '../../../i18n'
import {
  type CanvasProject,
  projectDisplayName,
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
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
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
  return createPortal(
    <div
      className="studio-handoff-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <section
        className="studio-handoff-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('handoff.title')}
      >
        <div className="studio-handoff-head">
          <div className="studio-handoff-icon">
            <Images size={20} />
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label={t('handoff.close')}>
            <X size={18} />
          </button>
        </div>
        <h2>{t('handoff.title')}</h2>
        <p>{t('handoff.description', { count })}</p>
        <button
          ref={first}
          type="button"
          className="studio-handoff-choice"
          disabled={busy}
          onClick={() => void choose()}
        >
          <Plus size={18} />
          <span>
            <strong>{t('handoff.new')}</strong>
            <small>{t('handoff.newHint')}</small>
          </span>
          <ArrowRight size={16} />
        </button>
        {canvases.length > 0 && (
          <>
            <div className="studio-handoff-subtitle">{t('handoff.existing')}</div>
            <div className="studio-handoff-list">
              {canvases.map((project) => (
                <button
                  type="button"
                  className="studio-handoff-choice"
                  key={project.id}
                  disabled={busy}
                  onClick={() => void choose(project.id)}
                >
                  <LayoutDashboard size={18} />
                  <span>
                    <strong>{projectDisplayName(project.name)}</strong>
                  </span>
                  <ArrowRight size={16} />
                </button>
              ))}
            </div>
          </>
        )}
        {failed && (
          <p role="alert" className="studio-handoff-error">
            {t('handoff.failed')}
          </p>
        )}
      </section>
    </div>,
    document.body,
  )
}
