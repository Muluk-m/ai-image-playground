import type {
  ProductionContext,
  ProductionDocument,
  ProductionShot,
  ProductionStoryboardProposal,
} from '@image-playground/shared'
import { ArrowDown, ArrowUp, Clapperboard, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Input } from '../../../components/ui/input'
import { Textarea } from '../../../components/ui/textarea'
import { useTranslation } from '../../../i18n'
import type { ProductionResponse } from '../lib/productionClient'
import { setProductionPanelContext, setProductionSelection } from '../lib/productionContext'
import {
  adoptStoryboard,
  discardStoryboard,
  fetchStoryboards,
} from '../lib/productionStoryboardClient'
import { useProductionEditor } from '../lib/useProductionEditor'
import ProductionReferenceEditor from './ProductionReferenceEditor'
import ProductionReferencePreview from './ProductionReferencePreview'
import ProductionShotSummary from './ProductionShotSummary'

export default function ProductionShotPane({
  document,
  onClose,
  onSaved,
  refreshKey = '',
}: {
  document: ProductionDocument
  onClose: () => void
  onSaved: (next: ProductionResponse) => void
  refreshKey?: string
}) {
  const { t } = useTranslation('production')
  const edit = useProductionEditor(document, onSaved)
  const shots = edit.content.shots ?? []
  const [selected, setSelected] = useState<string | null>(null)
  const [removeId, setRemoveId] = useState<string | null>(null)
  const [proposals, setProposals] = useState<readonly ProductionStoryboardProposal[]>([])
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let active = true
    setFailed(false)
    void fetchStoryboards(document.conversationId)
      .then((result) => {
        if (active) setProposals(result.storyboardProposals ?? [])
      })
      .catch(() => {
        if (active) setFailed(true)
      })
    return () => {
      active = false
    }
  }, [document.conversationId, document.revision, refreshKey])
  useEffect(() => {
    if (selected && !document.content.shots?.some((shot) => shot.id === selected)) setSelected(null)
  }, [document.content.shots, selected])
  useEffect(() => {
    setProductionPanelContext(document.conversationId, {
      documentId: document.id,
      revision: document.revision,
      target: selected ? 'shot' : 'shots',
      ...(selected ? { shotId: selected } : {}),
    })
    return () => setProductionPanelContext(document.conversationId, null)
  }, [document.conversationId, document.id, document.revision, selected])
  useEffect(() => {
    const locate = (event: Event) => {
      const detail = (event as CustomEvent<{ conversationId: string; context?: ProductionContext }>)
        .detail
      if (
        detail.conversationId !== document.conversationId ||
        detail.context?.target !== 'shot' ||
        !detail.context.shotId
      )
        return
      const id = detail.context.shotId
      setSelected(id)
      globalThis.document
        .querySelector(`[data-production-shot="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
    window.addEventListener('production:locate', locate)
    return () => window.removeEventListener('production:locate', locate)
  }, [document.conversationId])
  const update = (shot: ProductionShot) =>
    edit.update({
      ...edit.content,
      shots: shots.map((item) => (item.id === shot.id ? shot : item)),
    })
  const move = (index: number, offset: number) => {
    const next = [...shots]
    const [shot] = next.splice(index, 1)
    next.splice(index + offset, 0, shot!)
    edit.update({ ...edit.content, shots: next })
  }
  const resolve = async (proposal: ProductionStoryboardProposal, adopt: boolean) => {
    setBusy(true)
    setFailed(false)
    try {
      const result = adopt
        ? await adoptStoryboard(document.conversationId, proposal.id, proposal.baseRevision)
        : await discardStoryboard(document.conversationId, proposal.id)
      setProposals(result.storyboardProposals)
      onSaved(result)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  const looks = (edit.content.characters ?? []).flatMap((character) =>
    character.looks.map((look) => ({ ...look, label: `${character.name} · ${look.name}` })),
  )
  return (
    <section
      className="production-document production-storyboard"
      aria-label={t('storyboard.title')}
    >
      <header className="production-pane-header">
        <span>
          <Clapperboard size={17} />
          {t('storyboard.title')}
        </span>
        <button type="button" aria-label={t('close')} onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <div className="production-document-tools">
        {edit.editing ? (
          <>
            <button
              type="button"
              className="production-primary"
              data-action="save-shots"
              disabled={edit.saving}
              onClick={() => void edit.save()}
            >
              {t(edit.saving ? 'saving' : 'done')}
            </button>
            <button
              type="button"
              disabled={edit.saving}
              onClick={() => {
                setRemoveId(null)
                edit.keep()
              }}
            >
              {t('keepDraft')}
            </button>
            <button
              type="button"
              disabled={edit.saving}
              onClick={() => {
                setRemoveId(null)
                edit.discard()
              }}
            >
              {t('discard')}
            </button>
          </>
        ) : (
          <button type="button" aria-label={t('storyboard.edit')} onClick={edit.start}>
            <Pencil size={14} />
            {t('edit')}
          </button>
        )}
        <span>{t('revision', { revision: document.revision })}</span>
      </div>
      {(failed || edit.error) && (
        <p role="alert" className="production-error">
          {t(edit.error ?? 'storyboard.failed')}
        </p>
      )}
      <div className="production-document-scroll">
        {proposals
          .filter((proposal) => proposal.status === 'pending')
          .map((proposal) => (
            <section
              className="production-storyboard-proposal"
              key={proposal.id}
              aria-label={t('storyboard.proposal')}
            >
              <div>
                <strong>{t('storyboard.proposal')}</strong>
                <span>{t('revision', { revision: proposal.baseRevision })}</span>
              </div>
              <p>{t('storyboard.proposalHint')}</p>
              <details>
                <summary>{t('storyboard.review', { count: proposal.shots.length })}</summary>
                {proposal.shots.map((shot, index) => (
                  <div key={shot.id}>
                    <ProductionShotSummary shot={shot} index={index} content={document.content} />
                    {shot.keyframe && (
                      <div className="production-shot-keyframe">
                        <ProductionReferencePreview
                          conversationId={document.conversationId}
                          reference={shot.keyframe}
                          name={t('storyboard.keyframe')}
                        />
                      </div>
                    )}
                  </div>
                ))}
              </details>
              {proposal.baseRevision !== document.revision && (
                <p className="production-error">{t('storyboard.stale')}</p>
              )}
              <footer>
                <button
                  type="button"
                  className="production-primary"
                  disabled={busy || edit.editing || proposal.baseRevision !== document.revision}
                  onClick={() => void resolve(proposal, true)}
                >
                  {t('storyboard.adopt')}
                </button>
                <button type="button" disabled={busy} onClick={() => void resolve(proposal, false)}>
                  {t('storyboard.discard')}
                </button>
              </footer>
            </section>
          ))}
        <div className="production-storyboard-heading">
          <h1>{document.content.title}</h1>
          <span>{t('storyboard.count', { count: shots.length })}</span>
        </div>
        {!shots.length && <p className="production-prose">{t('storyboard.empty')}</p>}
        {shots.map((shot, index) => (
          <article
            key={shot.id}
            className="production-shot"
            data-production-shot={shot.id}
            data-selected={selected === shot.id}
          >
            <header>
              <button
                type="button"
                aria-pressed={selected === shot.id}
                onClick={() => {
                  const next = selected === shot.id ? null : shot.id
                  setSelected(next)
                  setProductionSelection(
                    document.conversationId,
                    next
                      ? {
                          documentId: document.id,
                          revision: document.revision,
                          target: 'shot',
                          shotId: next,
                        }
                      : null,
                  )
                }}
              >
                <span className="production-scene-number">
                  {String(index + 1).padStart(2, '0')}
                </span>
                {t('storyboard.shot', { number: index + 1 })}
              </button>
              {edit.editing && (
                <div>
                  <button
                    type="button"
                    aria-label={t('storyboard.moveUp', { number: index + 1 })}
                    disabled={edit.saving || index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp size={15} />
                  </button>
                  <button
                    type="button"
                    aria-label={t('storyboard.moveDown', { number: index + 1 })}
                    disabled={edit.saving || index === shots.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown size={15} />
                  </button>
                  <button
                    type="button"
                    aria-label={t('storyboard.remove', { number: index + 1 })}
                    disabled={edit.saving}
                    onClick={() => setRemoveId(shot.id)}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              )}
            </header>
            {edit.editing && removeId === shot.id && (
              <div className="production-shot-delete" role="alert">
                <p>{t('storyboard.deleteImpact')}</p>
                <button
                  type="button"
                  onClick={() => {
                    edit.update({
                      ...edit.content,
                      shots: shots.filter((item) => item.id !== shot.id),
                    })
                    setRemoveId(null)
                    if (selected === shot.id) setSelected(null)
                  }}
                >
                  {t('storyboard.confirmDelete')}
                </button>
                <button type="button" onClick={() => setRemoveId(null)}>
                  {t('cancel')}
                </button>
              </div>
            )}
            {edit.editing ? (
              <div className="production-shot-editor">
                <label>
                  {t('storyboard.description')}
                  <Textarea
                    value={shot.description}
                    disabled={edit.saving}
                    onChange={(event) => update({ ...shot, description: event.target.value })}
                  />
                </label>
                <label>
                  {t('storyboard.dialogue')}
                  <Textarea
                    value={shot.dialogue ?? ''}
                    disabled={edit.saving}
                    onChange={(event) =>
                      update({ ...shot, dialogue: event.target.value || undefined })
                    }
                  />
                </label>
                <div className="production-shot-fields">
                  <label>
                    {t('storyboard.camera')}
                    <Input
                      value={shot.camera ?? ''}
                      disabled={edit.saving}
                      onChange={(event) =>
                        update({ ...shot, camera: event.target.value || undefined })
                      }
                    />
                  </label>
                  <label>
                    {t('storyboard.duration')}
                    <Input
                      type="number"
                      min="0.1"
                      step="0.1"
                      value={shot.durationSeconds ?? ''}
                      disabled={edit.saving}
                      onChange={(event) =>
                        update({
                          ...shot,
                          durationSeconds: event.target.value
                            ? Number(event.target.value)
                            : undefined,
                        })
                      }
                    />
                  </label>
                </div>
                <label>
                  {t('storyboard.scriptScene')}
                  <select
                    value={shot.scriptSceneId ?? ''}
                    disabled={edit.saving}
                    onChange={(event) =>
                      update({ ...shot, scriptSceneId: event.target.value || undefined })
                    }
                  >
                    <option value="">{t('storyboard.unset')}</option>
                    {shot.scriptSceneId &&
                      !edit.content.scenes.some((scene) => scene.id === shot.scriptSceneId) && (
                        <option value={shot.scriptSceneId}>{t('storyboard.missing')}</option>
                      )}
                    {edit.content.scenes.map((scene) => (
                      <option key={scene.id} value={scene.id}>
                        {scene.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t('storyboard.location')}
                  <select
                    value={shot.locationId ?? ''}
                    disabled={edit.saving}
                    onChange={(event) =>
                      update({ ...shot, locationId: event.target.value || undefined })
                    }
                  >
                    <option value="">{t('storyboard.unset')}</option>
                    {shot.locationId &&
                      !edit.content.locations?.some(
                        (location) => location.id === shot.locationId,
                      ) && <option value={shot.locationId}>{t('storyboard.missing')}</option>}
                    {edit.content.locations?.map((location) => (
                      <option key={location.id} value={location.id}>
                        {location.name}
                      </option>
                    ))}
                  </select>
                </label>
                <fieldset>
                  <legend>{t('storyboard.looks')}</legend>
                  {looks.map((look) => (
                    <label key={look.id}>
                      <input
                        type="checkbox"
                        checked={shot.lookIds.includes(look.id)}
                        disabled={edit.saving}
                        onChange={(event) =>
                          update({
                            ...shot,
                            lookIds: event.target.checked
                              ? [...shot.lookIds, look.id]
                              : shot.lookIds.filter((id) => id !== look.id),
                          })
                        }
                      />
                      {look.label}
                    </label>
                  ))}
                  {shot.lookIds
                    .filter((id) => !looks.some((look) => look.id === id))
                    .map((id) => (
                      <label key={id}>
                        <input
                          type="checkbox"
                          checked
                          disabled={edit.saving}
                          onChange={() =>
                            update({ ...shot, lookIds: shot.lookIds.filter((one) => one !== id) })
                          }
                        />
                        {t('storyboard.missing')} · {id}
                      </label>
                    ))}
                </fieldset>
                <ProductionReferenceEditor
                  name={t('storyboard.keyframe')}
                  conversationId={document.conversationId}
                  value={shot.keyframe}
                  disabled={edit.saving}
                  onChange={(reference) => update({ ...shot, keyframe: reference })}
                />
              </div>
            ) : (
              <>
                <ProductionShotSummary shot={shot} index={index} content={edit.content} />
                {shot.keyframe && (
                  <div className="production-shot-keyframe">
                    <ProductionReferencePreview
                      conversationId={document.conversationId}
                      reference={shot.keyframe}
                      name={t('storyboard.keyframe')}
                    />
                  </div>
                )}
              </>
            )}
          </article>
        ))}
        {edit.editing && (
          <button
            type="button"
            className="production-add-scene"
            disabled={edit.saving || shots.length >= 200}
            onClick={() =>
              edit.update({
                ...edit.content,
                shots: [...shots, { id: crypto.randomUUID(), description: '', lookIds: [] }],
              })
            }
          >
            <Plus size={15} />
            {t('storyboard.add')}
          </button>
        )}
      </div>
    </section>
  )
}
