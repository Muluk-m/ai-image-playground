// PROTOTYPE：挂在两处输入框下方的模板 chip。点选后模板像技能命令一样出现在**输入框顶部**：
// 生成模式直接写进真实输入框（`/模板名 `），假面板由 `PickedLookCapsule` 渲染在编辑区第一行。
import { useSyncExternalStore } from 'react'
import { useStore } from '../store'
import ChipRowPrototype, { LookCapsule } from './ChipRowPrototype'
import type { ProtoLook } from './data'
import { isProto } from './proto'

let picked: ProtoLook | null = null
const listeners = new Set<() => void>()
function setPicked(next: ProtoLook | null) {
  picked = next
  for (const fn of listeners) fn()
}
function usePicked() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => picked,
  )
}

/** 假面板编辑区第一行的模板胶囊。 */
export function PickedLookCapsule() {
  const look = usePicked()
  if (!look) return null
  return <LookCapsule look={look} onRemove={() => setPicked(null)} />
}

export default function ComposerChipsPrototype({ surface }: { surface: 'agent' | 'generate' }) {
  if (!isProto()) return null
  return (
    <div className="px-1">
      <ChipRowPrototype
        compact={surface === 'agent'}
        onPick={(look) => {
          setPicked(look)
          if (surface === 'generate') {
            const store = useStore.getState()
            const rest = store.prompt.replace(/^\/\S+\s*/, '')
            store.setPrompt(`/${look.name} ${rest}`)
            store.showToast(`已切到 ${look.model} · ${look.size}`, 'info')
          }
        }}
      />
    </div>
  )
}
