// PROTOTYPE：模板卡「用它出图」批量弹窗。A = 两步（先选素材再定数量）；B/C = 单屏矩阵。
import { useState } from 'react'
import Overlay from '../components/Overlay'
import { ASSETS, type ProtoAsset, type ProtoLook } from './data'
import { useVariant } from './proto'

export default function BatchDialogPrototype({
  look,
  onClose,
}: {
  look: ProtoLook
  onClose: () => void
}) {
  const variant = useVariant()
  const [picked, setPicked] = useState<Record<string, number>>({})
  const [step, setStep] = useState<1 | 2>(1)
  const candidates = ASSETS.filter((a) => a.kind)
  const total = Object.values(picked).reduce((sum, n) => sum + n, 0)
  const toggle = (asset: ProtoAsset) =>
    setPicked((p) => {
      const next = { ...p }
      if (next[asset.id]) delete next[asset.id]
      else next[asset.id] = 1
      return next
    })

  const header = (
    <div className="flex items-center gap-3">
      <img src={look.cover} alt="" className="h-12 w-10 rounded-md object-cover" />
      <div className="min-w-0">
        <div className="text-sm font-medium">用「{look.name}」出图</div>
        <div className="text-[11px] text-muted-foreground">
          {look.model} · {look.size} · 每条素材填 {look.slots} 个素材位
        </div>
      </div>
      <button type="button" onClick={onClose} className="ml-auto text-xs text-muted-foreground">
        关闭
      </button>
    </div>
  )

  const footer = (
    <div className="mt-4 flex items-center gap-3 border-t border-border pt-3">
      <span className="text-xs text-muted-foreground">
        {Object.keys(picked).length} 条素材 · 共 {total} 张 · 预估 {total * 8} 积分
      </span>
      <button
        type="button"
        disabled={total === 0}
        onClick={onClose}
        className="ml-auto rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-40"
      >
        提交 {total} 张
      </button>
    </div>
  )

  if (variant === 'A') {
    return (
      <Overlay onClose={onClose}>
        <div className="w-[min(92vw,640px)] rounded-2xl border border-border bg-card p-4">
          {header}
          <div className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className={step === 1 ? 'font-medium text-foreground' : ''}>1 选素材</span>
            <span>→</span>
            <span className={step === 2 ? 'font-medium text-foreground' : ''}>2 每条几张</span>
          </div>
          {step === 1 ? (
            <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
              {candidates.map((asset) => (
                <button
                  key={asset.id}
                  type="button"
                  onClick={() => toggle(asset)}
                  className={`relative overflow-hidden rounded-lg border-2 text-left ${picked[asset.id] ? 'border-primary' : 'border-border'}`}
                >
                  <img src={asset.views[0].src} alt="" className="aspect-square w-full object-cover" />
                  <div className="truncate px-1.5 py-1 text-[11px]">{asset.name}</div>
                </button>
              ))}
            </div>
          ) : (
            <div className="mt-3 divide-y divide-border rounded-lg border border-border">
              {candidates
                .filter((a) => picked[a.id])
                .map((asset) => (
                  <div key={asset.id} className="flex items-center gap-2 px-2 py-1.5">
                    <img src={asset.views[0].src} alt="" className="h-9 w-9 rounded-md object-cover" />
                    <span className="flex-1 truncate text-xs">{asset.name}</span>
                    <Stepper
                      value={picked[asset.id]}
                      onChange={(n) => setPicked((p) => ({ ...p, [asset.id]: n }))}
                    />
                  </div>
                ))}
            </div>
          )}
          <div className="mt-4 flex items-center gap-3 border-t border-border pt-3">
            {step === 2 && (
              <button type="button" onClick={() => setStep(1)} className="text-xs text-muted-foreground">
                ← 改选素材
              </button>
            )}
            <span className="ml-auto text-xs text-muted-foreground">
              {Object.keys(picked).length} 条 · {total} 张
            </span>
            {step === 1 ? (
              <button
                type="button"
                disabled={Object.keys(picked).length === 0}
                onClick={() => setStep(2)}
                className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-40"
              >
                下一步
              </button>
            ) : (
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
              >
                提交 {total} 张
              </button>
            )}
          </div>
        </div>
      </Overlay>
    )
  }

  // B / C：单屏矩阵，每行一条素材 + 数量。
  return (
    <Overlay onClose={onClose}>
      <div className="w-[min(92vw,640px)] rounded-2xl border border-border bg-card p-4">
        {header}
        <div className="mt-3 divide-y divide-border rounded-lg border border-border">
          {candidates.map((asset) => (
            <div key={asset.id} className="flex items-center gap-2 px-2 py-1.5">
              <input
                type="checkbox"
                checked={Boolean(picked[asset.id])}
                onChange={() => toggle(asset)}
                className="h-4 w-4"
              />
              <img src={asset.views[0].src} alt="" className="h-9 w-9 rounded-md object-cover" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs">{asset.name}</div>
                <div className="text-[10px] text-muted-foreground">
                  {asset.kind} · {asset.views.length} 张视角 · {asset.background ?? '—'}
                </div>
              </div>
              <Stepper
                value={picked[asset.id] ?? 0}
                disabled={!picked[asset.id]}
                onChange={(n) => setPicked((p) => ({ ...p, [asset.id]: n }))}
              />
            </div>
          ))}
        </div>
        {footer}
      </div>
    </Overlay>
  )
}

function Stepper({
  value,
  onChange,
  disabled,
}: {
  value: number
  onChange: (n: number) => void
  disabled?: boolean
}) {
  return (
    <div className={`flex items-center rounded-md border border-border ${disabled ? 'opacity-30' : ''}`}>
      <button
        type="button"
        disabled={disabled || value <= 1}
        onClick={() => onChange(value - 1)}
        className="px-2 py-0.5 text-xs"
      >
        −
      </button>
      <span className="w-6 text-center text-xs">{value}</span>
      <button
        type="button"
        disabled={disabled || value >= 4}
        onClick={() => onChange(value + 1)}
        className="px-2 py-0.5 text-xs"
      >
        +
      </button>
    </div>
  )
}
