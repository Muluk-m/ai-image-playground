import type { ReactNode } from 'react'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import type { NodeReference } from '../lib/nodeCanvasFlow'

/** 贴在选中节点下面。外壳跟工作台生成栏是同一张 studio-direct-card，里面的控件按节点类型换。 */
export default function NodeComposerFrame({
  label,
  position,
  references,
  files,
  children,
}: {
  label: string
  position: { left: number; top: number }
  references: readonly NodeReference[]
  files: Readonly<Record<string, string>>
  children: ReactNode
}) {
  const { t } = useTranslation('canvas')
  return (
    <div
      className="studio-node-composer nodrag nopan nowheel"
      style={{ left: position.left, top: position.top }}
      role="group"
      aria-label={label}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="studio-direct-card">
        {references.length > 0 && (
          <div className="flex flex-wrap gap-1.5" aria-label={t('nodes.contextLabel')}>
            {references.map((ref) => {
              const source = ref.fileId ? files[ref.fileId] : undefined
              const name = ref.label || t(ref.kind === 'text' ? 'nodes.addText' : 'nodes.addImage')
              return (
                <span
                  key={ref.id}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-muted px-1.5 py-1 text-xs"
                >
                  {source ? (
                    <img src={source} alt="" className="h-6 w-6 rounded-sm object-cover" />
                  ) : (
                    <Icon
                      name={ref.kind === 'text' ? 'text' : ref.kind === 'video' ? 'video' : 'image'}
                      size="xs"
                    />
                  )}
                  <span className="max-w-40 truncate">{name}</span>
                </span>
              )
            })}
          </div>
        )}
        {children}
      </div>
    </div>
  )
}
