// PROTOTYPE：挂在两处输入框下方的「模板 chip + 已选模板胶囊」。
import { useState } from 'react'
import { useStore } from '../store'
import ChipRowPrototype, { LookCapsule } from './ChipRowPrototype'
import type { ProtoLook } from './data'
import { isProto } from './proto'

export default function ComposerChipsPrototype({ surface }: { surface: 'agent' | 'generate' }) {
  const [picked, setPicked] = useState<ProtoLook | null>(null)
  if (!isProto()) return null
  return (
    <div className="flex flex-col gap-1.5 px-1">
      {picked && <LookCapsule look={picked} onRemove={() => setPicked(null)} />}
      <ChipRowPrototype
        compact={surface === 'agent'}
        onPick={(look) => {
          setPicked(look)
          if (surface === 'generate')
            useStore
              .getState()
              .showToast(`已套用模板「${look.name}」：提示词已填入，模型切到 ${look.model} · ${look.size}`, 'info')
        }}
      />
      {picked && (
        <p className="text-[10px] text-muted-foreground">
          {surface === 'agent'
            ? `发送时随消息带上模板 id；再 @ ${picked.slots} 条素材即可。`
            : `附上 ${picked.slots} 条素材后直接生成；缺素材时按钮不可用。`}
        </p>
      )}
    </div>
  )
}
