import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'

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
    <Button
      type="button"
      variant="outline"
      onClick={onClick}
      className={`h-auto w-full ${aspect === 'portrait' ? 'aspect-[4/5]' : 'aspect-square'} flex-col gap-2 whitespace-normal rounded-2xl border-dashed border-border bg-muted/30 text-sm font-normal text-muted-foreground hover:border-primary hover:bg-transparent hover:text-foreground`}
    >
      <Icon name="add" size="lg" />
      {label}
    </Button>
  )
}
