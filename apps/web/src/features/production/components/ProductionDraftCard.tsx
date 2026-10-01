import { FileImage } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '../../../components/ui/button'
import { useTranslation } from '../../../i18n'
import { scopedStorageName } from '../../../lib/authScope'
import { useAgentStore } from '../../agent/store'
import type { AgentToolMessage } from '../../agent/types'
import { openProductionContent, type ProductionPane } from '../lib/productionContext'
import { listGenerations } from '../lib/productionGenerationClient'

export default function ProductionDraftCard({
  message,
  onOpen,
}: {
  message: AgentToolMessage
  onOpen?: (pane?: ProductionPane) => void
}) {
  const { t } = useTranslation('production')
  const conversationId = useAgentStore((state) => state.conversationId)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [conversationId, message.id])
  const open = async () => {
    if (busy || !conversationId) return
    const scope = scopedStorageName('production-draft-navigation')
    const abort = new AbortController()
    controller.current = abort
    setBusy(true)
    setFailed(false)
    try {
      const { generations } = await listGenerations(conversationId, abort.signal, message.id)
      if (
        abort.signal.aborted ||
        useAgentStore.getState().conversationId !== conversationId ||
        scopedStorageName('production-draft-navigation') !== scope
      )
        return
      const generation = generations.find((one) => one.messageId === message.id)
      if (!generation) throw new Error('missing')
      const { documentId, target, targetId } = generation.production
      const pane: ProductionPane = { documentId, target, targetId, messageId: message.id }
      if (onOpen) onOpen(pane)
      else openProductionContent(conversationId, pane)
    } catch {
      if (!abort.signal.aborted) setFailed(true)
    } finally {
      if (!abort.signal.aborted) setBusy(false)
    }
  }
  return (
    <div className="rounded-xl border border-border p-3 space-y-2">
      <div className="flex items-center gap-2">
        <FileImage size={16} />
        <strong className="text-sm">{message.title}</strong>
      </div>
      <Button
        type="button"
        variant="secondary"
        disabled={busy || !conversationId}
        onClick={() => void open()}
      >
        {t('generation.reviewDraft')}
      </Button>
      {failed && (
        <p role="alert" className="text-sm text-destructive">
          {t('generation.draftUnavailable')}
        </p>
      )}
    </div>
  )
}
