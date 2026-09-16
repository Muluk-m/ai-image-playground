import { PlusIcon } from '../../../components/icons'

export default function NewAssetButton({
  onClick,
  className = '',
}: {
  onClick: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1 rounded-lg bg-primary/10 px-3 py-1.5 text-sm font-medium text-primary transition hover:bg-primary/20 ${className}`}
    >
      <PlusIcon className="h-4 w-4" />
      新建素材
    </button>
  )
}
