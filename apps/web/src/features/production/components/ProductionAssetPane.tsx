import type {
  ProductionCharacter,
  ProductionDocument,
  ProductionLocation,
} from '@image-playground/shared'
import { MapPin, Plus, UserRound, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Input } from '../../../components/ui/input'
import { Textarea } from '../../../components/ui/textarea'
import { useTranslation } from '../../../i18n'
import { type ProductionResponse, saveProduction } from '../lib/productionClient'
import { useProductionEditor } from '../lib/useProductionEditor'
import ProductionReferenceEditor from './ProductionReferenceEditor'

export interface ProductionAssetTarget {
  kind: 'character' | 'location'
  id: string | null
}
export default function ProductionAssetPane({
  document,
  target,
  onSaved,
  onClose,
}: {
  document: ProductionDocument
  target: ProductionAssetTarget
  onSaved: (next: ProductionResponse) => void
  onClose: () => void
}) {
  const { t } = useTranslation('production')
  const [id] = useState(() => target.id ?? crypto.randomUUID())
  const edit = useProductionEditor(document, onSaved, `${target.kind}:${id}`)
  const [lookId, setLookId] = useState<string>()
  const [deleting, setDeleting] = useState<'asset' | 'look' | null>(null)
  const [removing, setRemoving] = useState(false)
  const [deleteFailed, setDeleteFailed] = useState(false)
  const collection = target.kind === 'character' ? 'characters' : 'locations'
  useEffect(() => {
    if (edit.draft) return
    if (target.id) edit.start()
    else {
      const base = {
        id,
        name: t(target.kind === 'character' ? 'asset.newCharacter' : 'asset.newLocation'),
        description: '',
      }
      const asset =
        target.kind === 'character'
          ? {
              ...base,
              looks: [{ id: crypto.randomUUID(), name: t('asset.defaultLook'), description: '' }],
            }
          : base
      edit.update({
        ...document.content,
        [collection]: [...(document.content[collection] ?? []), asset],
      })
    }
  }, [])
  const asset = edit.content[collection]?.find((one) => one.id === id)
  const character =
    target.kind === 'character' ? (asset as ProductionCharacter | undefined) : undefined
  const look = character?.looks.find((one) => one.id === lookId) ?? character?.looks[0]
  const update = (next: ProductionCharacter | ProductionLocation) =>
    edit.update({
      ...edit.content,
      [collection]: (edit.content[collection] ?? []).map((one) => (one.id === id ? next : one)),
    })
  const remove = async () => {
    if (!deleting || removing) return
    setRemoving(true)
    setDeleteFailed(false)
    const content =
      deleting === 'look' && character && look
        ? {
            ...edit.content,
            characters: (edit.content.characters ?? []).map((one) =>
              one.id === id
                ? { ...one, looks: one.looks.filter((item) => item.id !== look.id) }
                : one,
            ),
          }
        : {
            ...edit.content,
            [collection]: (edit.content[collection] ?? []).filter((one) => one.id !== id),
          }
    try {
      const next = await saveProduction(document.conversationId, {
        operationId: `remove:${document.revision}:${id}:${deleting === 'look' ? look?.id : 'asset'}`,
        baseRevision: edit.draft?.baseRevision ?? document.revision,
        content,
      })
      onSaved(next)
      edit.discard()
      if (deleting === 'asset') onClose()
      setDeleting(null)
    } catch {
      setDeleteFailed(true)
    } finally {
      setRemoving(false)
    }
  }
  const move = (direction: -1 | 1) => {
    const items = [...(edit.content[collection] ?? [])]
    const from = items.findIndex((one) => one.id === id)
    const to = from + direction
    if (from < 0 || to < 0 || to >= items.length) return
    const item = items.splice(from, 1)[0]!
    items.splice(to, 0, item)
    edit.update({ ...edit.content, [collection]: items })
  }
  const relatedShots =
    'shots' in edit.content && Array.isArray(edit.content.shots)
      ? edit.content.shots
          .filter((shot) =>
            target.kind === 'location'
              ? shot.locationId === id
              : (shot.lookIds ?? []).some((lookRef: string) =>
                  character?.looks.some((one) => one.id === lookRef),
                ),
          )
          .map((shot) => shot.description ?? shot.id)
      : []
  return (
    <section className="production-document" aria-label={t(`asset.${target.kind}`)}>
      <header className="production-pane-header">
        <span>
          {target.kind === 'character' ? <UserRound size={17} /> : <MapPin size={17} />}{' '}
          {asset?.name}
        </span>
        <button type="button" aria-label={t('close')} onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <div className="production-document-tools">
        <button
          type="button"
          className="production-primary"
          disabled={edit.saving || !asset}
          onClick={() => void edit.save()}
        >
          {t(edit.saving ? 'saving' : 'asset.save')}
        </button>
        <span>{t('revision', { revision: document.revision })}</span>
      </div>
      {edit.error && (
        <p className="production-error" role="alert">
          {t(edit.error)}
        </p>
      )}
      {deleteFailed && (
        <p className="production-error" role="alert">
          {t('conflict')}
        </p>
      )}
      {asset && (
        <div className="production-document-scroll production-asset-form">
          <label>
            {t('asset.assetName')}
            <Input
              aria-label={t('asset.assetName')}
              value={asset.name}
              disabled={edit.saving}
              onChange={(event) => update({ ...asset, name: event.target.value })}
            />
          </label>
          <label>
            {t('asset.description')}
            <Textarea
              aria-label={t('asset.description')}
              value={asset.description}
              disabled={edit.saving}
              onChange={(event) => update({ ...asset, description: event.target.value })}
            />
          </label>
          {!character && (
            <ProductionReferenceEditor
              conversationId={document.conversationId}
              name={asset.name}
              value={(asset as ProductionLocation).reference}
              disabled={edit.saving}
              onChange={(reference) => update({ ...asset, reference })}
            />
          )}
          {character && (
            <>
              <div className="production-look-tabs">
                {character.looks.map((one) => (
                  <button
                    type="button"
                    key={one.id}
                    aria-pressed={one.id === look?.id}
                    onClick={() => setLookId(one.id)}
                  >
                    {one.name}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    const next = {
                      id: crypto.randomUUID(),
                      name: t('asset.defaultLook'),
                      description: '',
                    }
                    update({ ...character, looks: [...character.looks, next] })
                    setLookId(next.id)
                  }}
                >
                  <Plus size={14} />
                  {t('asset.addLook')}
                </button>
              </div>
              {look && (
                <>
                  <ProductionReferenceEditor
                    key={look.id}
                    conversationId={document.conversationId}
                    name={`${character.name} · ${look.name}`}
                    value={look.reference}
                    disabled={edit.saving}
                    onChange={(reference) =>
                      update({
                        ...character,
                        looks: character.looks.map((one) =>
                          one.id === look.id ? { ...one, reference } : one,
                        ),
                      })
                    }
                  />
                  <label>
                    {t('asset.lookName')}
                    <Input
                      aria-label={t('asset.lookName')}
                      value={look.name}
                      disabled={edit.saving}
                      onChange={(event) =>
                        update({
                          ...character,
                          looks: character.looks.map((one) =>
                            one.id === look.id ? { ...one, name: event.target.value } : one,
                          ),
                        })
                      }
                    />
                  </label>
                  <label>
                    {t('asset.lookDescription')}
                    <Textarea
                      aria-label={t('asset.lookDescription')}
                      value={look.description}
                      disabled={edit.saving}
                      onChange={(event) =>
                        update({
                          ...character,
                          looks: character.looks.map((one) =>
                            one.id === look.id ? { ...one, description: event.target.value } : one,
                          ),
                        })
                      }
                    />
                  </label>
                </>
              )}
            </>
          )}
          <div className="production-reference-actions">
            <button type="button" disabled={edit.saving || removing} onClick={() => move(-1)}>
              {t('asset.up')}
            </button>
            <button type="button" disabled={edit.saving || removing} onClick={() => move(1)}>
              {t('asset.down')}
            </button>
          </div>
          <div className="production-asset-danger">
            {deleting ? (
              <>
                <p>{t('asset.deleteImpact')}</p>
                {relatedShots.length > 0 && (
                  <ul>
                    {relatedShots.map((name: string, index: number) => (
                      <li key={`${index}:${name}`}>{name}</li>
                    ))}
                  </ul>
                )}
                <div className="production-reference-actions">
                  <button type="button" disabled={removing} onClick={() => void remove()}>
                    {t('asset.deleteConfirm')}
                  </button>
                  <button type="button" disabled={removing} onClick={() => setDeleting(null)}>
                    {t('cancel')}
                  </button>
                </div>
              </>
            ) : (
              <>
                <button type="button" disabled={edit.saving} onClick={() => setDeleting('asset')}>
                  {t('asset.delete')}
                </button>
                {look && (
                  <button type="button" disabled={edit.saving} onClick={() => setDeleting('look')}>
                    {t('asset.deleteLook')}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
