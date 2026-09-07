import { normalizeInventory } from '@image-playground/shared'
import { useState } from 'react'
import { FIELD, LABEL } from '../../../components/panelStyles'

const BOX = `flex flex-wrap items-center gap-1.5 ${FIELD} focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-100 dark:focus-within:border-blue-500/50 dark:focus-within:ring-blue-500/15`

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
    onChange(normalizeInventory([...inventory, draft]))
    setDraft('')
  }

  return (
    <div>
      <span className={LABEL}>产品清单</span>
      <div data-product-shots-plan-inventory className={`mt-1 ${BOX}`}>
        {inventory.map((name, index) => (
          <span key={`${name}-${index}`} data-product-shots-plan-chip={name} className={CHIP}>
            {name}
            <button
              type="button"
              aria-label={`删除 ${name}`}
              onClick={() => onChange(inventory.filter((_, at) => at !== index))}
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
