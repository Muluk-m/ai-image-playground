import { useState } from 'react'
import { CloseIcon } from '../../../components/icons'
import Overlay from '../../../components/Overlay'
import { describeError, useTranslation } from '../../../i18n'
import { useStore } from '../../../store'
import { submitLookBatch } from '../lib/batchClient'
import type { LookItem } from '../lib/looks'
import { useLibraryStore } from '../store'
import type { AssetRecord } from '../types'
import { assetCoverImageId } from '../types'
import AssetThumb from './AssetThumb'
import LookImage from './LookImage'

const PER_ASSET_MAX = 4

/** 「用它出图」：先选素材，再定每条几张，一次提交。 */
export default function BatchDialog({ look, onClose }: { look: LookItem; onClose: () => void }) {
  const { t } = useTranslation(['library', 'common'])
  const assets = useLibraryStore((s) => s.assets)
  const noteLookUsed = useLibraryStore((s) => s.noteLookUsed)
  const showToast = useStore((s) => s.showToast)
  const [step, setStep] = useState<1 | 2>(1)
  const [picked, setPicked] = useState<Record<string, number>>({})
  const [submitting, setSubmitting] = useState(false)

  const candidates = assets.filter((asset) => asset.kind)
  const pickedIds = candidates.filter((asset) => picked[asset.id]).map((asset) => asset.id)
  const total = pickedIds.reduce((sum, id) => sum + picked[id], 0)
  // 多素材位的模板一次只出一张：选中的素材按顺序填位，数量对所有位共用。
  const perAsset = look.slotCount > 1 ? (picked[pickedIds[0]] ?? 1) : 0
  const submitCount = look.slotCount > 1 ? perAsset : total
  const selectionValid =
    look.slotCount > 1 ? pickedIds.length === look.slotCount : pickedIds.length > 0

  const toggle = (asset: AssetRecord) =>
    setPicked((current) => {
      const next = { ...current }
      if (next[asset.id]) delete next[asset.id]
      else next[asset.id] = 1
      return next
    })

  const submit = async () => {
    if (!selectionValid || submitting) return
    setSubmitting(true)
    try {
      const result = await submitLookBatch({
        ...(look.record ? { lookId: look.record.id } : { skillName: look.skillName }),
        assetIds: pickedIds,
        perAsset: look.slotCount > 1 ? perAsset : 1,
        counts:
          look.slotCount > 1
            ? undefined
            : Object.fromEntries(pickedIds.map((id) => [id, picked[id]])),
      })
      if (look.record) void noteLookUsed(look.record.id)
      showToast(t('batch.submitted', { count: result.tasks.length }), 'success')
      onClose()
    } catch (error) {
      showToast(t('batch.failed', { reason: describeError(error) }), 'error')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Overlay onClose={onClose} tier="raised">
      <div className="relative z-10 w-[min(94vw,640px)] rounded-3xl border border-border bg-card p-5 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:ring-white/10">
        <div className="flex items-center gap-3">
          <div className="h-12 w-10 shrink-0 overflow-hidden rounded-lg border border-border">
            <LookImage source={look.cover} alt={look.name} />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-semibold text-foreground">
              {t('batch.title', { name: look.name })}
            </h3>
            <p className="text-[11px] text-muted-foreground">
              {look.model} · {look.size} · {t('look.slots', { count: look.slotCount })}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common:action.close')}
            className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

        <ol className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
          <li className={step === 1 ? 'font-medium text-foreground' : ''}>
            1 {t('batch.stepAssets')}
          </li>
          <li aria-hidden="true">→</li>
          <li className={step === 2 ? 'font-medium text-foreground' : ''}>
            2 {t('batch.stepCounts')}
          </li>
        </ol>

        {step === 1 ? (
          candidates.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">{t('batch.noAssets')}</p>
          ) : (
            <ul className="mt-3 grid max-h-[50vh] grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4">
              {candidates.map((asset) => (
                <li key={asset.id}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={Boolean(picked[asset.id])}
                    onClick={() => toggle(asset)}
                    className={`group w-full overflow-hidden rounded-xl border-2 text-left transition ${
                      picked[asset.id] ? 'border-primary' : 'border-border hover:border-primary/50'
                    }`}
                  >
                    <div className="aspect-square bg-muted">
                      <AssetThumb imageId={assetCoverImageId(asset)} alt={asset.name} />
                    </div>
                    <span className="block truncate px-1.5 py-1 text-[11px] text-foreground">
                      {asset.name}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : (
          <ul className="mt-3 max-h-[50vh] divide-y divide-border overflow-y-auto rounded-xl border border-border">
            {candidates
              .filter((asset) => picked[asset.id])
              .map((asset, index) => (
                <li key={asset.id} className="flex items-center gap-2 px-2 py-1.5">
                  <div className="h-9 w-9 shrink-0 overflow-hidden rounded-md border border-border">
                    <AssetThumb imageId={assetCoverImageId(asset)} alt={asset.name} />
                  </div>
                  <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                    {asset.name}
                  </span>
                  {(look.slotCount === 1 || index === 0) && (
                    <Stepper
                      value={picked[asset.id]}
                      onChange={(n) => setPicked((p) => ({ ...p, [asset.id]: n }))}
                    />
                  )}
                </li>
              ))}
          </ul>
        )}

        <div className="mt-4 flex items-center gap-3 border-t border-border pt-3">
          {step === 2 && (
            <button
              type="button"
              onClick={() => setStep(1)}
              className="text-xs text-muted-foreground transition hover:text-foreground"
            >
              ← {t('batch.back')}
            </button>
          )}
          <span className="ml-auto text-xs text-muted-foreground">
            {t('batch.summary', { assets: pickedIds.length, count: submitCount })}
          </span>
          {step === 1 ? (
            <button
              type="button"
              disabled={!selectionValid}
              onClick={() => setStep(2)}
              className="rounded-xl bg-primary px-4 py-2 text-xs font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t('batch.next')}
            </button>
          ) : (
            <button
              type="button"
              disabled={submitting || submitCount === 0}
              onClick={() => void submit()}
              className="rounded-xl bg-primary px-4 py-2 text-xs font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t('batch.submit', { count: submitCount })}
            </button>
          )}
        </div>
      </div>
    </Overlay>
  )
}

function Stepper({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <div className="flex items-center rounded-md border border-border">
      <button
        type="button"
        disabled={value <= 1}
        onClick={() => onChange(value - 1)}
        aria-label="−"
        className="px-2 py-0.5 text-xs disabled:opacity-30"
      >
        −
      </button>
      <span className="w-6 text-center text-xs tabular-nums">{value}</span>
      <button
        type="button"
        disabled={value >= PER_ASSET_MAX}
        onClick={() => onChange(value + 1)}
        aria-label="+"
        className="px-2 py-0.5 text-xs disabled:opacity-30"
      >
        +
      </button>
    </div>
  )
}
