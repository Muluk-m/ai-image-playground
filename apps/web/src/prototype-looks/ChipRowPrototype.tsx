// PROTOTYPE：输入框下方的模板 chip。A = 单行 pill（截图风格）；B = 双行分层（自建 / 预置）；C = 小封面卡横滑。
// 点 chip 在输入框上方插入一个「模板胶囊」（原型里是独立的一行，不进 contentEditable）。
import { ChevronRight, X } from 'lucide-react'
import { useState } from 'react'
import { LOOKS, PURPOSE_TONE, type ProtoLook } from './data'
import { useVariant } from './proto'

const PILL =
  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-border bg-background px-3 text-xs text-foreground transition hover:border-primary hover:bg-muted'

function Badge({ look }: { look: ProtoLook }) {
  if (look.needsRetune)
    return <span className="rounded bg-warning/15 px-1 text-[10px] text-warning">需重新调试</span>
  if (look.badge)
    return (
      <span
        className={`rounded px-1 text-[10px] ${look.badge === 'Hot' ? 'bg-warning/15 text-warning' : 'bg-info/15 text-info'}`}
      >
        {look.badge}
      </span>
    )
  return null
}

function PurposeDot({ look }: { look: ProtoLook }) {
  return (
    <span className={`rounded px-1 text-[10px] ${PURPOSE_TONE[look.purpose]}`}>{look.purpose}</span>
  )
}

export function LookCapsule({ look, onRemove }: { look: ProtoLook; onRemove: () => void }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 px-2 py-1 text-xs">
      <img src={look.cover} alt="" className="h-6 w-5 rounded object-cover" />
      <span className="font-medium">模板 · {look.name}</span>
      <span className="text-muted-foreground">
        {look.model} · {look.size} · 需要 {look.slots} 个素材
      </span>
      <button type="button" onClick={onRemove} className="ml-auto text-muted-foreground">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

export default function ChipRowPrototype({
  onPick,
  compact,
}: {
  onPick: (look: ProtoLook) => void
  compact?: boolean
}) {
  const variant = useVariant()
  const [expanded, setExpanded] = useState(false)
  const mine = LOOKS.filter((l) => l.origin === '自建')
  const builtin = LOOKS.filter((l) => l.origin === '预置')

  if (variant === 'B') {
    return (
      <div className="flex flex-col gap-1.5 pt-2">
        <Row title="我的" list={mine} onPick={onPick} />
        <Row title="预置" list={builtin} onPick={onPick} more />
      </div>
    )
  }
  if (variant === 'C') {
    return (
      <div className="flex gap-2 overflow-x-auto pt-2 pb-1">
        {[...mine, ...builtin].map((look) => (
          <button
            key={look.id}
            type="button"
            disabled={look.needsRetune}
            onClick={() => onPick(look)}
            className="group flex w-[88px] shrink-0 flex-col gap-1 text-left disabled:opacity-40"
          >
            <div className="relative overflow-hidden rounded-lg border border-border">
              <img src={look.cover} alt="" className="aspect-[4/5] w-full object-cover" />
              <div className="absolute left-1 top-1 flex flex-col gap-0.5">
                <PurposeDot look={look} />
                {look.origin === '预置' && (
                  <span className="rounded bg-black/55 px-1 text-[10px] text-white">预置</span>
                )}
              </div>
            </div>
            <span className="truncate text-[11px] group-hover:text-primary">{look.name}</span>
          </button>
        ))}
        <button
          type="button"
          className="flex w-[88px] shrink-0 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border text-[11px] text-muted-foreground"
        >
          更多模板 <ChevronRight className="h-3 w-3" />
        </button>
      </div>
    )
  }
  // A：单行 pill，自建在前用实心点区分，预置带 New / Hot。
  const list = expanded ? [...mine, ...builtin] : [...mine, ...builtin].slice(0, compact ? 3 : 5)
  return (
    <div className="flex items-center gap-2 overflow-x-auto pt-2">
      {list.map((look) => (
        <button
          key={look.id}
          type="button"
          disabled={look.needsRetune}
          onClick={() => onPick(look)}
          className={`${PILL} disabled:opacity-40`}
        >
          <span className="text-muted-foreground">/</span>
          {look.origin === '自建' && <span className="h-1.5 w-1.5 rounded-full bg-primary" />}
          {look.name}
          <Badge look={look} />
        </button>
      ))}
      <button type="button" onClick={() => setExpanded((v) => !v)} className={PILL}>
        {expanded ? '收起' : '更多模板'} <ChevronRight className="h-3 w-3" />
      </button>
    </div>
  )
}

function Row({
  title,
  list,
  onPick,
  more,
}: {
  title: string
  list: ProtoLook[]
  onPick: (l: ProtoLook) => void
  more?: boolean
}) {
  return (
    <div className="flex items-center gap-2 overflow-x-auto">
      <span className="w-8 shrink-0 text-[10px] text-muted-foreground">{title}</span>
      {list.map((look) => (
        <button
          key={look.id}
          type="button"
          disabled={look.needsRetune}
          onClick={() => onPick(look)}
          className={`${PILL} disabled:opacity-40`}
        >
          <PurposeDot look={look} />
          {look.name}
          <Badge look={look} />
        </button>
      ))}
      {more && (
        <button type="button" className={`${PILL} text-muted-foreground`}>
          更多 <ChevronRight className="h-3 w-3" />
        </button>
      )}
    </div>
  )
}
