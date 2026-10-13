import {
  addStoryboardShot,
  type CanvasNode,
  type CanvasSnapshot,
  connectCanvasNodes,
  deleteStoryboardShot,
  disconnectCanvasNodes,
  PRODUCTION_SHOTS_MAX,
  type ProductionShot,
  readCanvasDocument,
  reorderStoryboardShots,
  storyboardFingerprint,
  updateCanvasNode,
  updateStoryboardShot,
} from '@image-playground/shared'
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import Credits from '../../../components/Credits'
import Badge from '../../../components/patterns/Badge'
import Dialog from '../../../components/patterns/Dialog'
import Overlay from '../../../components/patterns/Overlay'
import { Button } from '../../../components/ui/button'
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
import { clientProfileToApiProfile, getActiveApiProfile } from '../../../lib/apiProfiles'
import { usePrivateSubmissionGuard } from '../../../lib/privateOverlay'
import { useStore } from '../../../store'
import type { NodeCanvasDocument } from '../lib/nodeCanvasDocument'
import NodePorts from './NodePorts'
import StoryboardProductionActions from './StoryboardProductionActions'

export const NodeStoryboardContext = createContext<{
  canvas: NodeCanvasDocument
  snapshot: CanvasSnapshot
  onRun?: (ids: string[]) => void
} | null>(null)
type StoryboardNode = Extract<CanvasNode, { type: 'storyboard' }>
export default function NodeStoryboard({ node }: { node: StoryboardNode }) {
  const context = useContext(NodeStoryboardContext)
  const { t } = useTranslation('canvas')
  const [open, setOpen] = useState(false)
  if (!context) return null
  const confirmed = node.data.confirmed?.fingerprint === storyboardFingerprint(node.data.shots)
  return (
    <>
      <NodePorts nodeId={node.id} />
      <div className="studio-node-caption text-xs text-muted-foreground">
        <Icon name="storyboard" size="xs" />
        {t('storyboard.title')}
      </div>
      <div
        className="studio-node flex h-full flex-col gap-3 border border-border bg-card p-4 text-foreground"
        onDoubleClick={() => setOpen(true)}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">
            {t('storyboard.count', { count: node.data.shots.length })}
          </span>
          <Badge tone={confirmed ? 'success' : 'neutral'}>
            {t(confirmed ? 'storyboard.confirmed' : 'storyboard.draft')}
          </Badge>
          <Button size="sm" variant="ghost" className="nodrag nopan" onClick={() => setOpen(true)}>
            <Icon name="fullscreen" />
            {t('storyboard.edit')}
          </Button>
        </div>
        <ol
          className="nodrag nopan nowheel min-h-0 flex-1 space-y-2 overflow-y-auto text-xs"
          aria-label={t('storyboard.shots')}
        >
          {node.data.shots.map((shot, index) => (
            <li key={shot.id} className="flex gap-3 rounded-lg bg-muted/50 px-3 py-2">
              <span className="text-muted-foreground tabular-nums">
                {String(index + 1).padStart(2, '0')}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {shot.description || t('storyboard.emptyShot')}
              </span>
              <span className="text-muted-foreground">{shot.durationSeconds ?? 5}s</span>
            </li>
          ))}
          {!node.data.shots.length && (
            <li className="flex h-full items-center justify-center text-muted-foreground">
              {t('storyboard.empty')}
            </li>
          )}
        </ol>
        <Button
          size="sm"
          variant="secondary"
          className="nodrag nopan self-start"
          onClick={() => setOpen(true)}
        >
          <Icon name="add" />
          {t('storyboard.addShot')}
        </Button>
      </div>
      {open && <StoryboardEditor node={node} {...context} onClose={() => setOpen(false)} />}
    </>
  )
}

function StoryboardEditor({
  node,
  canvas,
  snapshot,
  onRun,
  onClose,
}: {
  node: StoryboardNode
  canvas: NodeCanvasDocument
  snapshot: CanvasSnapshot
  onClose: () => void
  onRun?: (ids: string[]) => void
}) {
  const { t } = useTranslation('canvas')
  const surface = useRef<HTMLElement>(null)
  const close = () => {
    const active = document.activeElement
    if (active instanceof HTMLElement && surface.current?.contains(active)) active.blur()
    onClose()
  }
  const [confirm, setConfirm] = useState(false)
  const settings = useStore((s) => s.settings)
  const profile = getActiveApiProfile(settings)
  const model = clientProfileToApiProfile(profile).model
  const guard = usePrivateSubmissionGuard({ model, quantity: node.data.shots.length })
  const shots = node.data.shots
  const fingerprint = storyboardFingerprint(shots)
  const confirmed = node.data.confirmed?.fingerprint === fingerprint
  const [confirmFingerprint, setConfirmFingerprint] = useState('')
  const assets = snapshot.nodes.filter(
    (n): n is Extract<CanvasNode, { type: 'image' }> =>
      n.type === 'image' && n.data.meta?.nodeKind === 'asset',
  )
  const change = (fn: () => void) => {
    canvas.undo.stopCapturing()
    canvas.doc.transact(fn, canvas.origin)
    canvas.undo.stopCapturing()
  }
  const mutateShot = (operation: () => void) =>
    change(() => {
      operation()
      const current = readCanvasDocument(canvas.doc).nodes.find((n) => n.id === node.id)
      if (current?.type !== 'storyboard') return
      const wanted = new Set(
        current.data.shots.flatMap((shot) => [
          ...shot.lookIds,
          ...(shot.locationId ? [shot.locationId] : []),
        ]),
      )
      for (const source of wanted)
        connectCanvasNodes(canvas.doc, { source, target: node.id }, canvas.origin)
      for (const edge of snapshot.edges)
        if (
          edge.target === node.id &&
          assets.some((asset) => asset.id === edge.source) &&
          !wanted.has(edge.source)
        )
          disconnectCanvasNodes(canvas.doc, edge.id, canvas.origin)
    })
  const update = (id: string, patch: Partial<ProductionShot>) =>
    mutateShot(() => updateStoryboardShot(canvas.doc, node.id, id, patch, canvas.origin))
  const move = (index: number, offset: number) => {
    const ids = shots.map((s) => s.id),
      [id] = ids.splice(index, 1)
    ids.splice(index + offset, 0, id!)
    change(() => reorderStoryboardShots(canvas.doc, node.id, ids, canvas.origin))
  }
  const ready =
    shots.length > 0 &&
    shots.length <= PRODUCTION_SHOTS_MAX &&
    shots.every((shot) => shot.description.trim())
  return (
    <Overlay onClose={close} layout="fill" backdrop="none" role="none">
      <section
        role="dialog"
        aria-modal="true"
        aria-label={t('storyboard.edit')}
        className="flex h-full w-full flex-col bg-background text-foreground"
        ref={surface}
      >
        <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
          <Icon name="storyboard" />
          <h2 className="mr-auto text-sm font-semibold">
            {t('storyboard.title')} · {shots.length}
          </h2>
          <Badge tone={confirmed ? 'success' : 'neutral'}>
            {t(confirmed ? 'storyboard.confirmed' : 'storyboard.draft')}
          </Badge>
          <Button
            size="sm"
            variant="outline"
            disabled={shots.length >= PRODUCTION_SHOTS_MAX}
            onClick={() =>
              change(() => {
                addStoryboardShot(
                  canvas.doc,
                  node.id,
                  { id: crypto.randomUUID(), description: '', lookIds: [], durationSeconds: 5 },
                  canvas.origin,
                )
              })
            }
          >
            <Icon name="add" />
            {t('storyboard.addShot')}
          </Button>
          <Button
            size="sm"
            disabled={!ready || confirmed}
            onClick={() => {
              setConfirmFingerprint(fingerprint)
              setConfirm(true)
            }}
          >
            {t('storyboard.finalize')}
          </Button>
          {onRun && (
            <StoryboardProductionActions
              canvas={canvas}
              id={node.id}
              ready={ready && confirmed}
              onRun={(ids) => {
                close()
                onRun(ids)
              }}
            />
          )}
          <Button size="icon-sm" variant="ghost" aria-label={t('storyboard.close')} onClick={close}>
            <Icon name="close" />
          </Button>
        </header>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 sm:p-6">
          {shots.length > PRODUCTION_SHOTS_MAX && (
            <p role="alert" className="text-sm text-destructive">
              {t('storyboard.overflow', { max: PRODUCTION_SHOTS_MAX })}
            </p>
          )}
          {shots.length === 0 && (
            <p className="py-12 text-center text-sm text-muted-foreground">
              {t('storyboard.empty')}
            </p>
          )}
          {shots.map((shot, index) => (
            <article
              key={shot.id}
              aria-label={t('storyboard.shot', { index: index + 1 })}
              className="rounded-xl border border-border bg-card p-4"
            >
              <div className="mb-3 flex items-center gap-2">
                <Badge tone="primary">{t('storyboard.shot', { index: index + 1 })}</Badge>
                <div className="ml-auto flex gap-1">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={!index}
                    aria-label={t('storyboard.up', { index: index + 1 })}
                    onClick={() => move(index, -1)}
                  >
                    <Icon name="moveUp" />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={index === shots.length - 1}
                    aria-label={t('storyboard.down', { index: index + 1 })}
                    onClick={() => move(index, 1)}
                  >
                    <Icon name="moveDown" />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t('storyboard.remove', { index: index + 1 })}
                    onClick={() =>
                      mutateShot(() =>
                        deleteStoryboardShot(canvas.doc, node.id, shot.id, canvas.origin),
                      )
                    }
                  >
                    <Icon name="delete" />
                  </Button>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <ShotField
                  label={t('storyboard.description')}
                  value={shot.description}
                  multiline
                  onSave={(description) => update(shot.id, { description })}
                />
                <ShotField
                  label={t('storyboard.dialogue')}
                  value={shot.dialogue ?? ''}
                  multiline
                  onSave={(dialogue) => update(shot.id, { dialogue })}
                />
                <ShotField
                  label={t('storyboard.camera')}
                  value={shot.camera ?? ''}
                  onSave={(camera) => update(shot.id, { camera })}
                />
                <ShotField
                  label={t('storyboard.duration')}
                  value={String(shot.durationSeconds ?? 5)}
                  numeric
                  onSave={(value) => {
                    const durationSeconds = Number(value)
                    if (
                      Number.isFinite(durationSeconds) &&
                      durationSeconds > 0 &&
                      durationSeconds <= 600
                    )
                      update(shot.id, { durationSeconds })
                  }}
                />
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <AssetReferences
                  label={t('storyboard.people')}
                  values={[...shot.lookIds]}
                  assets={assets.filter((a) => a.data.meta?.assetKind === 'person')}
                  onChange={(lookIds) => update(shot.id, { lookIds })}
                />
                <AssetReferences
                  label={t('storyboard.location')}
                  values={shot.locationId ? [shot.locationId] : []}
                  assets={assets.filter((a) => a.data.meta?.assetKind === 'location')}
                  single
                  onChange={(ids) => update(shot.id, { locationId: ids[0] })}
                />
              </div>
            </article>
          ))}
        </div>
      </section>
      {confirm && (
        <Dialog
          tier="raised"
          title={t('storyboard.confirmTitle')}
          onClose={() => setConfirm(false)}
          footer={
            <>
              <Button variant="outline" onClick={() => setConfirm(false)}>
                {t('storyboard.cancel')}
              </Button>
              <Button
                disabled={guard.blocked || fingerprint !== confirmFingerprint || !ready}
                onClick={() => {
                  const current = readCanvasDocument(canvas.doc).nodes.find((n) => n.id === node.id)
                  if (
                    current?.type !== 'storyboard' ||
                    storyboardFingerprint(current.data.shots) !== confirmFingerprint
                  )
                    return
                  change(() =>
                    updateCanvasNode(
                      canvas.doc,
                      node.id,
                      {
                        data: {
                          ...current.data,
                          confirmed: {
                            fingerprint: confirmFingerprint,
                            model,
                            quantity: shots.length,
                            ...(guard.estimatedCredits === undefined
                              ? {}
                              : { credits: guard.estimatedCredits }),
                          },
                        },
                      },
                      canvas.origin,
                    ),
                  )
                  setConfirm(false)
                }}
              >
                {t('storyboard.confirm')}
              </Button>
            </>
          }
        >
          <p className="text-sm">{t('storyboard.batch', { count: shots.length })}</p>
          <p className="mt-2 text-sm text-muted-foreground">{model}</p>
          {guard.estimatedCredits !== undefined && (
            <p className="mt-3 flex gap-2 text-sm">
              {t('nodes.estimatedCost')}
              <Credits credits={guard.estimatedCredits} />
            </p>
          )}
          {fingerprint !== confirmFingerprint && (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {t('storyboard.changed')}
            </p>
          )}
          {guard.disabledReason && (
            <p className="mt-3 text-sm text-destructive">{guard.disabledReason}</p>
          )}
        </Dialog>
      )}
    </Overlay>
  )
}

function ShotField({
  label,
  value,
  onSave,
  multiline,
  numeric,
}: {
  label: string
  value: string
  onSave: (value: string) => void
  multiline?: boolean
  numeric?: boolean
}) {
  const [draft, setDraft] = useState(value),
    focused = useRef(false),
    initial = useRef(value)
  useEffect(() => {
    if (!focused.current) setDraft(value)
  }, [value])
  const common = {
    value: draft,
    'aria-label': label,
    onFocus: () => {
      focused.current = true
      initial.current = value
    },
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setDraft(e.target.value),
    onBlur: () => {
      focused.current = false
      if (draft !== initial.current) onSave(draft)
      setDraft(value)
    },
  }
  return (
    <Label className="flex min-w-0 flex-col gap-2 text-xs text-muted-foreground">
      {label}
      {multiline ? (
        <Textarea
          {...common}
          className="min-h-20 resize-y text-sm text-foreground"
          maxLength={10000}
        />
      ) : (
        <Input
          {...common}
          className="text-sm text-foreground"
          type={numeric ? 'number' : 'text'}
          min={numeric ? 0.1 : undefined}
          max={numeric ? 600 : undefined}
          step={numeric ? 0.1 : undefined}
        />
      )}
    </Label>
  )
}
function AssetReferences({
  label,
  values,
  assets,
  onChange,
  single,
}: {
  label: string
  values: string[]
  assets: Extract<CanvasNode, { type: 'image' }>[]
  onChange: (ids: string[]) => void
  single?: boolean
}) {
  const { t } = useTranslation('canvas')
  return (
    <div className="min-w-0 space-y-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex flex-wrap gap-1">
        {values.map((id) => (
          <Button
            key={id}
            size="sm"
            variant="secondary"
            className="max-w-full gap-1 text-xs"
            onClick={() => onChange(values.filter((value) => value !== id))}
          >
            <Icon name="layers" size="xs" />
            <span className="truncate">
              {assets.find((a) => a.id === id)?.data.name ?? t('storyboard.missingAsset')}
            </span>
            <Icon name="close" size="xs" />
          </Button>
        ))}
      </div>
      <Select value="" onValueChange={(id) => onChange(single ? [id] : [...values, id])}>
        <SelectTrigger aria-label={label} className="h-8">
          <SelectValue placeholder={t('storyboard.addReference')} />
        </SelectTrigger>
        <SelectContent>
          {assets
            .filter((a) => !values.includes(a.id))
            .map((asset) => (
              <SelectItem key={asset.id} value={asset.id}>
                <Icon name="layers" size="xs" /> {asset.data.name}
              </SelectItem>
            ))}
          {!assets.some((a) => !values.includes(a.id)) && (
            <SelectItem disabled value="__empty__">
              {t('storyboard.noAssets')}
            </SelectItem>
          )}
        </SelectContent>
      </Select>
    </div>
  )
}
