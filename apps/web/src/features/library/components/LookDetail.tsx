import { useState } from 'react'
import Badge from '../../../components/Badge'
import { CloseIcon, EditIcon, TrashIcon } from '../../../components/icons'
import Overlay from '../../../components/Overlay'
import { useTranslation } from '../../../i18n'
import { formatDateTime } from '../../../i18n/format'
import { useStore } from '../../../store'
import AgentMarkdown from '../../agent/components/AgentMarkdown'
import { splitLookBody } from '../lib/lookBody'
import type { LookItem } from '../lib/looks'
import { useLibraryStore } from '../store'
import LookImage from './LookImage'

const ACTION =
  'inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl text-[13px] font-medium transition disabled:cursor-not-allowed disabled:opacity-40'

export default function LookDetail({
  look,
  body,
  needsRetune,
  canGenerate,
  onClose,
  onGenerate,
  onTune,
}: {
  look: LookItem
  /** 自建的正文在记录里；预置的由调用方从技能清单取。 */
  body: string
  needsRetune: boolean
  canGenerate: boolean
  onClose: () => void
  onGenerate: (look: LookItem) => void
  onTune: (look: LookItem) => void
}) {
  const { t } = useTranslation(['library', 'common'])
  const renameLook = useLibraryStore((s) => s.renameLook)
  const deleteLook = useLibraryStore((s) => s.deleteLook)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const [draftName, setDraftName] = useState<string | null>(null)
  const [index, setIndex] = useState(0)

  const images = [
    ...(look.cover ? [{ source: look.cover, label: t('lookDetail.cover') }] : []),
    ...look.references
      .filter((ref) => !look.cover || ref.kind !== look.cover.kind || key(ref) !== key(look.cover))
      .map((ref, i) => ({ source: ref, label: t('lookDetail.reference', { index: i + 1 }) })),
  ]
  const current = images[Math.min(index, Math.max(0, images.length - 1))]
  const sections = splitLookBody(body)
  const record = look.record

  const commitRename = () => {
    if (draftName !== null && record) void renameLook(record.id, draftName)
    setDraftName(null)
  }

  return (
    <Overlay onClose={onClose} tier="raised">
      <div className="relative z-10 flex h-[min(90vh,900px)] w-[min(96vw,1200px)] overflow-hidden rounded-3xl border border-border bg-card shadow-2xl ring-1 ring-black/5 animate-modal-in dark:ring-white/10">
        <div className="flex min-w-0 flex-[3] flex-col bg-black/5 dark:bg-black/40">
          <div className="relative flex min-h-0 flex-1 items-center justify-center p-6">
            {current ? (
              <div className="relative max-h-full max-w-full overflow-hidden rounded-xl shadow-2xl">
                <LookImage
                  source={current.source}
                  alt={look.name}
                  className="max-h-[calc(90vh-8rem)] max-w-full object-contain"
                />
                <Badge tone="overlay" className="absolute left-2 top-2">
                  {current.label}
                </Badge>
              </div>
            ) : (
              <div className="h-64 w-48 rounded-xl bg-muted" aria-hidden="true" />
            )}
          </div>
          {images.length > 1 && (
            <div className="flex gap-2 px-6 pb-4">
              {images.map((image, i) => (
                <button
                  key={key(image.source)}
                  type="button"
                  onClick={() => setIndex(i)}
                  aria-label={image.label}
                  aria-pressed={i === index}
                  className={`h-16 w-12 overflow-hidden rounded-lg border-2 ${i === index ? 'border-primary' : 'border-transparent opacity-60 hover:opacity-100'}`}
                >
                  <LookImage source={image.source} alt="" />
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex w-[400px] shrink-0 flex-col border-l border-border">
          <div className="flex items-start gap-2 border-b border-border px-5 py-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                {draftName === null ? (
                  <h3 className="min-w-0 truncate text-base font-semibold text-foreground">
                    {look.name}
                  </h3>
                ) : (
                  <input
                    autoFocus
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename()
                      if (e.key === 'Escape') setDraftName(null)
                    }}
                    maxLength={40}
                    className="min-w-0 flex-1 rounded-lg border border-primary bg-card px-2 py-1 text-base font-semibold text-foreground focus:outline-none"
                  />
                )}
                <Badge tone="primary">{t(`look.purpose.${look.purpose}`)}</Badge>
                {look.origin === 'builtin' && <Badge>{t('look.builtinTag')}</Badge>}
              </div>
              {look.description && (
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {look.description}
                </p>
              )}
              {record && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {t('lookDetail.updatedAt', { time: formatDateTime(record.updatedAt) })}
                </p>
              )}
            </div>
            {record && (
              <>
                <button
                  type="button"
                  onClick={() => setDraftName(look.name)}
                  aria-label={t('action.rename')}
                  title={t('action.rename')}
                  className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                >
                  <EditIcon className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setConfirmDialog({
                      title: t('look.deleteTitle'),
                      message: t('look.deleteMessage', { name: look.name }),
                      action: () => {
                        void deleteLook(record.id)
                        onClose()
                      },
                    })
                  }
                  aria-label={t('common:action.delete')}
                  title={t('common:action.delete')}
                  className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
                >
                  <TrashIcon className="h-4 w-4" />
                </button>
              </>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label={t('common:action.close')}
              className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
            >
              <CloseIcon className="h-4 w-4" />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {needsRetune && (
              <div className="mb-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
                {t('look.needsRetune')} · {look.model}
              </div>
            )}
            <div className="space-y-4 text-[13px] leading-relaxed text-foreground">
              {sections.map((section) => (
                <section key={section.title || section.body.slice(0, 24)}>
                  {section.title && (
                    <h4
                      className={`mb-1 text-[12px] font-medium ${
                        section.title === t('lookDetail.inputsSection')
                          ? 'text-primary'
                          : 'text-muted-foreground'
                      }`}
                    >
                      {section.title}
                    </h4>
                  )}
                  <AgentMarkdown text={section.body} />
                </section>
              ))}
            </div>
            <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
              <dt className="text-muted-foreground">{t('lookDetail.size')}</dt>
              <dd className="text-foreground">{look.size}</dd>
              <dt className="text-muted-foreground">{t('lookDetail.slots')}</dt>
              <dd className="text-foreground">{look.slotCount}</dd>
              <dt className="text-muted-foreground">{t('lookDetail.references')}</dt>
              <dd className="text-foreground">
                {t('lookDetail.referenceCount', { count: look.references.length })}
              </dd>
            </dl>
          </div>

          <div className="flex gap-2 border-t border-border px-5 py-4">
            <button
              type="button"
              disabled={needsRetune || !canGenerate}
              onClick={() => onGenerate(look)}
              className={`${ACTION} bg-primary text-primary-foreground hover:opacity-90`}
            >
              {t('look.generate')}
            </button>
            <button
              type="button"
              disabled={!canGenerate}
              onClick={() => onTune(look)}
              className={`${ACTION} border border-border text-foreground hover:bg-muted`}
            >
              {look.origin === 'user' ? t('look.tune') : t('look.fork')}
            </button>
          </div>
        </div>
      </div>
    </Overlay>
  )
}

function key(source: LookItem['references'][number]): string {
  return source.kind === 'image' ? `image:${source.imageId}` : `url:${source.url}`
}
