import type {
  ProductionContext,
  ProductionDocument,
  ProductionShot,
  ProductionStoryboardProposal,
} from '@image-playground/shared'
import { useEffect, useState } from 'react'
import { Button } from '../../../components/ui/button'
import { Checkbox } from '../../../components/ui/checkbox'
import { Icon } from '../../../components/ui/icon'
import { Input } from '../../../components/ui/input'
import { Label } from '../../../components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select'
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
import ProductionDeleteImpactNotice from './ProductionDeleteImpactNotice'
import ProductionDependencyNotice from './ProductionDependencyNotice'
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
  const edit = useProductionEditor(document, onSaved, 'shots')
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
          <Icon name="storyboard" />
          {t('storyboard.title')}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          type="button"
          aria-label={t('close')}
          onClick={onClose}
        >
          <Icon name="close" />
        </Button>
      </header>
      <div className="production-document-tools">
        {edit.editing ? (
          <>
            <Button
              variant="default"
              size="sm"
              type="button"
              data-action="save-shots"
              disabled={edit.saving}
              onClick={() => void edit.save()}
            >
              {t(edit.saving ? 'saving' : 'done')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              disabled={edit.saving}
              onClick={() => {
                setRemoveId(null)
                edit.keep()
              }}
            >
              {t('keepDraft')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              disabled={edit.saving}
              onClick={() => {
                setRemoveId(null)
                edit.discard()
              }}
            >
              {t('discard')}
            </Button>
          </>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            type="button"
            aria-label={t('storyboard.edit')}
            onClick={edit.start}
          >
            <Icon name="edit" />
            {t('edit')}
          </Button>
        )}
        <span>{t('revision', { revision: document.revision })}</span>
      </div>
      {(failed || edit.error) && (
        <p role="alert" className="production-error">
          {t(edit.error ?? 'storyboard.failed')}
        </p>
      )}
      <div className="production-document-scroll">
        {selected && !edit.editing && (
          <ProductionDependencyNotice
            document={document}
            target={{ kind: 'shot', id: selected }}
            onSaved={onSaved}
          />
        )}
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
                <Button
                  variant="default"
                  size="sm"
                  type="button"
                  disabled={busy || edit.editing || proposal.baseRevision !== document.revision}
                  onClick={() => void resolve(proposal, true)}
                >
                  {t('storyboard.adopt')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  disabled={busy}
                  onClick={() => void resolve(proposal, false)}
                >
                  {t('storyboard.discard')}
                </Button>
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
              <Button
                variant={selected === shot.id ? 'secondary' : 'ghost'}
                size="xs"
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
              </Button>
              {edit.editing && (
                <div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    type="button"
                    aria-label={t('storyboard.moveUp', { number: index + 1 })}
                    disabled={edit.saving || index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <Icon name="moveUp" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    type="button"
                    aria-label={t('storyboard.moveDown', { number: index + 1 })}
                    disabled={edit.saving || index === shots.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <Icon name="moveDown" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    type="button"
                    aria-label={t('storyboard.remove', { number: index + 1 })}
                    disabled={edit.saving}
                    onClick={() => setRemoveId(shot.id)}
                  >
                    <Icon name="delete" />
                  </Button>
                </div>
              )}
            </header>
            {edit.editing && removeId === shot.id && (
              <div className="production-shot-delete" role="alert">
                <ProductionDeleteImpactNotice
                  content={edit.content}
                  target={{ kind: 'shot', id: shot.id }}
                />
                <Button
                  variant="destructive"
                  size="sm"
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
                </Button>
                <Button variant="ghost" size="sm" type="button" onClick={() => setRemoveId(null)}>
                  {t('cancel')}
                </Button>
              </div>
            )}
            {edit.editing ? (
              <div className="production-shot-editor">
                <Label>
                  {t('storyboard.description')}
                  <Textarea
                    value={shot.description}
                    disabled={edit.saving}
                    onChange={(event) => update({ ...shot, description: event.target.value })}
                  />
                </Label>
                <Label>
                  {t('storyboard.dialogue')}
                  <Textarea
                    value={shot.dialogue ?? ''}
                    disabled={edit.saving}
                    onChange={(event) =>
                      update({ ...shot, dialogue: event.target.value || undefined })
                    }
                  />
                </Label>
                <div className="production-shot-fields">
                  <Label>
                    {t('storyboard.camera')}
                    <Input
                      value={shot.camera ?? ''}
                      disabled={edit.saving}
                      onChange={(event) =>
                        update({ ...shot, camera: event.target.value || undefined })
                      }
                    />
                  </Label>
                  <Label>
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
                  </Label>
                </div>
                <Label>
                  {t('storyboard.scriptScene')}
                  <Select
                    value={shot.scriptSceneId ? `id:${shot.scriptSceneId}` : '__unset__'}
                    disabled={edit.saving}
                    onValueChange={(value) =>
                      update({
                        ...shot,
                        scriptSceneId: value === '__unset__' ? undefined : value.slice(3),
                      })
                    }
                  >
                    <SelectTrigger aria-label={t('storyboard.scriptScene')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__unset__">{t('storyboard.unset')}</SelectItem>
                      {shot.scriptSceneId &&
                        !edit.content.scenes.some((scene) => scene.id === shot.scriptSceneId) && (
                          <SelectItem value={`id:${shot.scriptSceneId}`}>
                            {t('storyboard.missing')}
                          </SelectItem>
                        )}
                      {edit.content.scenes.map((scene) => (
                        <SelectItem key={scene.id} value={`id:${scene.id}`}>
                          {scene.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Label>
                <Label>
                  {t('storyboard.location')}
                  <Select
                    value={shot.locationId ? `id:${shot.locationId}` : '__unset__'}
                    disabled={edit.saving}
                    onValueChange={(value) =>
                      update({
                        ...shot,
                        locationId: value === '__unset__' ? undefined : value.slice(3),
                      })
                    }
                  >
                    <SelectTrigger aria-label={t('storyboard.location')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__unset__">{t('storyboard.unset')}</SelectItem>
                      {shot.locationId &&
                        !edit.content.locations?.some(
                          (location) => location.id === shot.locationId,
                        ) && (
                          <SelectItem value={`id:${shot.locationId}`}>
                            {t('storyboard.missing')}
                          </SelectItem>
                        )}
                      {edit.content.locations?.map((location) => (
                        <SelectItem key={location.id} value={`id:${location.id}`}>
                          {location.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Label>
                <fieldset>
                  <legend>{t('storyboard.looks')}</legend>
                  {looks.map((look) => (
                    <Label key={look.id}>
                      <Checkbox
                        checked={shot.lookIds.includes(look.id)}
                        disabled={edit.saving}
                        onCheckedChange={(checked) =>
                          update({
                            ...shot,
                            lookIds:
                              checked === true
                                ? [...shot.lookIds, look.id]
                                : shot.lookIds.filter((id) => id !== look.id),
                          })
                        }
                      />
                      {look.label}
                    </Label>
                  ))}
                  {shot.lookIds
                    .filter((id) => !looks.some((look) => look.id === id))
                    .map((id) => (
                      <Label key={id}>
                        <Checkbox
                          checked
                          disabled={edit.saving}
                          onCheckedChange={() =>
                            update({ ...shot, lookIds: shot.lookIds.filter((one) => one !== id) })
                          }
                        />
                        {t('storyboard.missing')} · {id}
                      </Label>
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
          <Button
            variant="ghost"
            size="sm"
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
            <Icon name="add" />
            {t('storyboard.add')}
          </Button>
        )}
      </div>
    </section>
  )
}
