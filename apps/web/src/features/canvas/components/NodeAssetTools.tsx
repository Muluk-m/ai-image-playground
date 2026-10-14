import { canvasMainResult, readCanvasDocument } from '@image-playground/shared'
import { useRef, useState } from 'react'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import { useStore } from '../../../store'
import type { CanvasEditor } from '../lib/editor'
import { assetDerivationPrompt, saveAssetNodeResult } from '../lib/nodeAssetGeneration'
import type { NodeCanvasDocument } from '../lib/nodeCanvasDocument'
import { submitNodeImage } from '../lib/nodeCanvasGenerate'

export default function NodeAssetTools({
  canvas,
  editor,
  nodeId,
  busy,
}: {
  canvas: NodeCanvasDocument
  editor: CanvasEditor
  nodeId: string
  busy: boolean
}) {
  const { t } = useTranslation('canvas')
  const [saving, setSaving] = useState(false)
  const active = useRef(false)
  const node = readCanvasDocument(canvas.doc).nodes.find((one) => one.id === nodeId)
  if (node?.type !== 'image' || node.data.meta?.nodeKind !== 'asset') return null
  const prompt = assetDerivationPrompt(node)
  const main = canvasMainResult(canvas.doc, nodeId)
  return (
    <div className="flex flex-wrap items-center gap-2">
      {prompt && (
        <Button
          variant="outline"
          size="sm"
          disabled={busy || saving}
          onClick={() => {
            const source = node.data.fileId && editor.doc.files[node.data.fileId]
            submitNodeImage(
              editor,
              canvas.doc,
              node.id,
              prompt,
              source ? [source] : [],
              undefined,
              node.data.meta?.assetKind === 'person' ? 'sheet' : undefined,
            )
          }}
        >
          <Icon name="generate" />
          {node.data.meta.assetKind === 'person'
            ? t('nodes.assetThreeViews')
            : t('nodes.assetEmptyScene')}
        </Button>
      )}
      {main && node.data.meta.assetSavedResultId !== main.id && (
        <Button
          variant="outline"
          size="sm"
          disabled={busy || saving}
          onClick={async () => {
            if (active.current) return
            active.current = true
            setSaving(true)
            try {
              const saved = await saveAssetNodeResult(editor, canvas.doc, node.id)
              useStore
                .getState()
                .showToast(
                  saved ? t('nodes.assetUpdated') : t('nodes.assetSaveFailed'),
                  saved ? 'success' : 'error',
                )
            } catch {
              useStore.getState().showToast(t('nodes.assetSaveFailed'), 'error')
            } finally {
              active.current = false
              setSaving(false)
            }
          }}
        >
          <Icon name="assets" />
          {t('nodes.assetUseResult')}
        </Button>
      )}
    </div>
  )
}
