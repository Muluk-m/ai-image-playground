import { useState } from 'react'
import { FIELD_BOX, LABEL } from '../../../components/panelStyles'

const CHIP =
  'inline-flex items-center gap-1 rounded-md bg-indigo-500/10 py-0.5 pl-2 pr-1 text-xs text-indigo-700 dark:text-indigo-300'

const REMOVE = 'rounded text-indigo-400 transition hover:text-indigo-700 dark:hover:text-indigo-200'

interface PlanInventoryProps {
  inventory: readonly string[]
  onChange: (inventory: readonly string[]) => void
}

export default function PlanInventory({ inventory, onChange }: PlanInventoryProps) {
  const [draft, setDraft] = useState('')

  const add = () => {
    if (!draft.trim()) return
    onChange([...inventory, draft])
    setDraft('')
  }

  return (
    <div>
      <span className={LABEL}>产品清单</span>
      <div data-product-shots-plan-inventory className={`mt-1 ${FIELD_BOX}`}>
        {/* 清单写进版本前已去重，所以名字可以既当 key 又当删除的判据。 */}
        {inventory.map((name) => (
          <span key={name} data-product-shots-plan-chip={name} className={CHIP}>
            {name}
            <button
              type="button"
              aria-label={`删除 ${name}`}
              onClick={() => onChange(inventory.filter((item) => item !== name))}
              className={REMOVE}
            >
              ×
            </button>
          </span>
        ))}
        <input
          type="text"
          aria-label="产品清单"
          placeholder="添加，回车确认"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            e.preventDefault()
            add()
          }}
          onBlur={add}
          className="min-w-[6rem] flex-1 bg-transparent text-sm outline-none placeholder:text-gray-400"
        />
      </div>
    </div>
  )
}
