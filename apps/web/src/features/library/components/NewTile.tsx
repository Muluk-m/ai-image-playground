import { PlusIcon } from '../../../components/icons'

/** 网格第一格：新建。高度跟着同格卡片走（素材方形、模板 4:5）。 */
export default function NewTile({
  label,
  onClick,
  aspect = 'square',
}: {
  label: string
  onClick: () => void
  aspect?: 'square' | 'portrait'
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex ${aspect === 'portrait' ? 'aspect-[4/5]' : 'aspect-square'} flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border bg-muted/30 text-sm text-muted-foreground transition hover:border-primary hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring/60`}
    >
      <PlusIcon className="h-6 w-6" />
      {label}
    </button>
  )
}
