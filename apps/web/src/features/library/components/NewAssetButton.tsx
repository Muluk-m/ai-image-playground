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
      className={`flex items-center gap-1 rounded-lg bg-blue-500/10 px-3 py-1.5 text-sm font-medium text-blue-700 transition hover:bg-blue-500/20 dark:bg-blue-500/15 dark:text-blue-300 dark:hover:bg-blue-500/25 ${className}`}
    >
      <PlusIcon className="h-4 w-4" />
      新建素材
    </button>
  )
}
