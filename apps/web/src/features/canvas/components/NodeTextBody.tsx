import type { TextNodeData } from '@image-playground/shared'
import { createContext, lazy, Suspense, useContext, useEffect, useState } from 'react'
import Overlay from '../../../components/patterns/Overlay'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import type { NodeCanvasDocument } from '../lib/nodeCanvasDocument'
import NodeTextContent from './NodeTextContent'

const NodeTextEditor = lazy(() => import('./NodeTextEditor'))
export const TextCanvasContext = createContext<NodeCanvasDocument | null>(null)

export default function NodeTextBody({
  nodeId,
  data,
  selected,
}: {
  nodeId: string
  data: TextNodeData
  selected?: boolean
}) {
  const { t } = useTranslation('canvas')
  const canvas = useContext(TextCanvasContext)
  const [editing, setEditing] = useState(false)
  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    if (!selected && !expanded) setEditing(false)
  }, [selected, expanded])
  const finish = () => {
    setEditing(false)
    setExpanded(false)
  }
  const expand = () => {
    setEditing(true)
    setExpanded(true)
  }
  const editor = canvas && (
    <Suspense
      fallback={
        <span className="p-4 text-sm text-muted-foreground">{t('nodes.editorLoading')}</span>
      }
    >
      <NodeTextEditor
        canvas={canvas}
        nodeId={nodeId}
        onDone={finish}
        onExpand={expanded ? undefined : expand}
      />
    </Suspense>
  )
  return (
    <>
      <div
        className="studio-node studio-node--text"
        onDoubleClick={(e) => {
          e.stopPropagation()
          setEditing(true)
        }}
      >
        {editing && !expanded ? (
          editor
        ) : (
          <>
            {selected && (
              <div className="studio-node-text-tools nodrag nopan">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('nodes.editFullscreen')}
                  onClick={expand}
                >
                  <Icon name="fullscreen" />
                </Button>
              </div>
            )}
            <div
              className="studio-node-text-body text-sm"
              tabIndex={selected ? 0 : -1}
              role="button"
              aria-label={t('nodes.composerText')}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === 'F2') {
                  e.preventDefault()
                  e.stopPropagation()
                  setEditing(true)
                }
              }}
            >
              {data.text || data.richText ? (
                <NodeTextContent data={data} />
              ) : (
                <span className="text-muted-foreground">{t('nodes.textPlaceholder')}</span>
              )}
            </div>
          </>
        )}
      </div>
      {expanded && (
        <Overlay label={t('nodes.editFullscreen')} layout="fill" backdrop="none" onClose={finish}>
          <div className="studio-node-script-sheet bg-background text-foreground">
            <header className="flex items-center justify-between gap-3 border-b px-4 py-3">
              <span className="min-w-0 truncate text-sm font-medium">
                {data.name || t('nodes.scriptEditor')}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('nodes.finishEditing')}
                onClick={finish}
              >
                <Icon name="close" />
              </Button>
            </header>
            {editor}
          </div>
        </Overlay>
      )}
    </>
  )
}
