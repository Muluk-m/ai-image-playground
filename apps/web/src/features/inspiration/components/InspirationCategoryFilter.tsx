import { useInspirationStore } from '../store'

export default function InspirationCategoryFilter() {
  const categories = useInspirationStore((s) => s.categories)
  const selectedCategory = useInspirationStore((s) => s.selectedCategory)
  const setCategory = useInspirationStore((s) => s.setCategory)

  return (
    <nav className="flex flex-col gap-1 p-2">
      <CategoryButton
        label="全部"
        active={selectedCategory === null}
        onClick={() => setCategory(null)}
      />
      {categories.map((category) => (
        <CategoryButton
          key={category}
          label={category}
          active={selectedCategory === category}
          onClick={() => setCategory(category)}
        />
      ))}
    </nav>
  )
}

function CategoryButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg px-3 py-2 text-left text-sm transition ${
        active
          ? 'bg-blue-500/10 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300 font-medium'
          : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/[0.04]'
      }`}
    >
      {label}
    </button>
  )
}
