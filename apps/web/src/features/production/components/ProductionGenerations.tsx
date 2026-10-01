import type {
  AgentToolArtifact,
  AgentToolErrorCode,
  ProductionDocument,
  ProductionGenerationView,
} from '@image-playground/shared'
import { useEffect, useRef, useState } from 'react'
import { Button } from '../../../components/ui/button'
import { useTranslation } from '../../../i18n'
import { getStoredChannels } from '../../../lib/channels/channelStore'
import { queueOutputUrl } from '../../../lib/channels/queueClient'
import {
  AgentRequestError,
  cancelJob,
  confirmToolPrompt,
  fetchMessages,
  retryToolCall,
} from '../../agent/lib/agentClient'
import { previewArtifactBitmap } from '../../agent/lib/artifactSource'
import { agentToolFailureText, promptAgentRecharge } from '../../agent/lib/toolFailure'
import { useAgentStore } from '../../agent/store'
import type { ProductionResponse } from '../lib/productionClient'
import {
  adoptGeneration,
  createGeneration,
  editGeneration,
  type GenerationFields,
  listGenerations,
} from '../lib/productionGenerationClient'
import ProductionGenerationEditor from './ProductionGenerationEditor'

function CandidatePreview({ artifact }: { artifact: AgentToolArtifact }) {
  const [bitmap, setBitmap] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    if (artifact.media !== 'video')
      void previewArtifactBitmap(artifact).then((value) => {
        if (active) setBitmap(value)
      })
    return () => {
      active = false
    }
  }, [artifact])
  if (artifact.media === 'video')
    return (
      <video
        controls
        preload="metadata"
        playsInline
        src={queueOutputUrl(artifact.taskId, artifact.outputIndex)}
      />
    )
  return bitmap ? <img src={bitmap} alt="" /> : <span>…</span>
}

interface ProductionGenerationsProps {
  conversationId: string
  document: ProductionDocument
  target: { kind: 'look' | 'location' | 'clip'; id: string }
  onSaved: (next: ProductionResponse) => void
  refreshKey?: string
  initialDraft?: GenerationFields
  preparationBlocked?: string
  onPreviewArtifact?: (generation: ProductionGenerationView, artifact: AgentToolArtifact) => void
  adoptedArtifactId?: string
}

export default function ProductionGenerations(props: ProductionGenerationsProps) {
  return (
    <GenerationSession
      key={`${props.conversationId}:${props.document.id}:${props.target.kind}:${props.target.id}`}
      {...props}
    />
  )
}

function GenerationSession({
  conversationId,
  document,
  target,
  onSaved,
  refreshKey = '',
  initialDraft,
  preparationBlocked,
  adoptedArtifactId,
  onPreviewArtifact,
}: ProductionGenerationsProps) {
  const { t } = useTranslation('production')
  const [generations, setGenerations] = useState<readonly ProductionGenerationView[]>([])
  const [error, setError] = useState(false)
  const [failureCode, setFailureCode] = useState<AgentToolErrorCode | undefined>(undefined)
  const [busy, setBusy] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [uncertain, setUncertain] = useState<ReadonlySet<string>>(new Set())
  const inFlight = useRef(false)
  const [creating, setCreating] = useState<GenerationFields | null>(null)
  const creatingRevision = useRef<number | null>(null)
  const creatingSource = useRef<GenerationFields | undefined>(undefined)
  const creatingStale = creating !== null && creatingRevision.current !== document.revision
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const syncMessages = async (ids: readonly string[]) => {
    if (useAgentStore.getState().conversationId !== conversationId) return
    const snapshot = await fetchMessages(conversationId)
    for (const message of snapshot.messages) {
      if (ids.includes(message.id))
        useAgentStore.getState().acceptGenerationReceipt(conversationId, message)
    }
  }
  const operations = useRef(new Map<string, string>())
  const readEpoch = useRef(0)
  const read = async (signal?: AbortSignal) => {
    const epoch = ++readEpoch.current
    const next = await listGenerations(conversationId, signal)
    if (!alive.current || signal?.aborted || epoch !== readEpoch.current) return null
    setGenerations(next.generations)
    setUncertain((previous) => {
      const remaining = [...previous].filter(
        (id) => !next.generations.some((item) => item.messageId === id),
      )
      return remaining.length === previous.size ? previous : new Set(remaining)
    })
    return next
  }
  useEffect(() => {
    const controller = new AbortController()
    void read(controller.signal)
      .then((next) => {
        if (next && !controller.signal.aborted) {
          setGenerations(next.generations)
          setError(false)
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true)
      })
    return () => controller.abort()
  }, [conversationId, document.revision, refreshKey, retry])
  useEffect(() => {
    if (
      busy ||
      (!uncertain.size &&
        !generations.some((item) => item.status === 'queued' || item.status === 'in_progress'))
    )
      return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void read(controller.signal).catch(() => {
        if (!controller.signal.aborted) {
          setError(true)
          setGenerations((previous) => [...previous])
        }
      })
    }, 2500)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [generations, busy, uncertain])
  const asset =
    target.kind === 'location'
      ? document.content.locations?.find((item) => item.id === target.id)
      : document.content.characters
          ?.flatMap((item) => item.looks)
          .find((item) => item.id === target.id)
  const assetReference = asset?.reference
  const adopted =
    adoptedArtifactId ??
    (assetReference?.kind === 'artifact' ? assetReference.artifactId : undefined)
  const startCandidate = () => {
    creatingRevision.current = document.revision
    creatingSource.current = initialDraft
    const previous = generations.find(
      (g) => g.production.target === target.kind && g.production.targetId === target.id,
    )
    const firstModel =
      getStoredChannels()
        .flatMap((c) => c.models)
        .find((m) => m.media === 'image')?.id ?? ''
    setCreating(
      initialDraft ??
        (previous
          ? {
              prompt: previous.prompt,
              model: previous.model,
              params: previous.params,
              video: previous.video,
              references: previous.references,
            }
          : {
              prompt: asset?.description ?? '',
              model: firstModel,
              references: asset?.reference ? [{ reference: asset.reference }] : [],
            }),
    )
  }
  const create = async (fields: GenerationFields) => {
    if (inFlight.current || preparationBlocked || creatingStale) return
    inFlight.current = true
    readEpoch.current++
    setBusy('new')
    setError(false)
    setFailureCode(undefined)
    try {
      const key = JSON.stringify({ revision: document.revision, target, fields })
      const operationId = operations.current.get(key) ?? crypto.randomUUID()
      operations.current.set(key, operationId)
      const sourceFields =
        target.kind === 'clip' && creatingSource.current ? creatingSource.current : fields
      let next = await createGeneration(conversationId, {
        ...sourceFields,
        operationId,
        baseRevision: document.revision,
        target: target.kind,
        targetId: target.id,
      })
      const signature = (value: GenerationFields) =>
        JSON.stringify([value.model, value.prompt, value.params, value.video, value.references])
      if (signature(sourceFields) !== signature(fields)) {
        next = await editGeneration(
          conversationId,
          next.generation.draftId,
          next.generation.draftRevision,
          fields,
        )
      }
      await syncMessages([next.generation.messageId])
      operations.current.delete(key)
      if (alive.current) {
        setGenerations((previous) => [
          ...previous.filter((item) => item.draftId !== next.generation.draftId),
          next.generation,
        ])
        setCreating(null)
      }
    } catch {
      setError(true)
    } finally {
      inFlight.current = false
      setBusy(null)
    }
  }
  const confirm = async (generation: ProductionGenerationView, fields: GenerationFields) => {
    if (inFlight.current || preparationBlocked || generation.sourceChanged) return
    inFlight.current = true
    readEpoch.current++
    setBusy(generation.draftId)
    setError(false)
    setFailureCode(undefined)
    let submitted = false
    try {
      const saved = await editGeneration(
        conversationId,
        generation.draftId,
        generation.draftRevision,
        fields,
      )
      submitted = true
      const message = await confirmToolPrompt(
        conversationId,
        generation.messageId,
        saved.generation.prompt,
        undefined,
        saved.generation.draftRevision,
      )
      useAgentStore.getState().acceptGenerationReceipt(conversationId, message)
    } catch (cause) {
      setError(true)
      if (cause instanceof AgentRequestError) {
        setFailureCode(cause.toolErrorCode)
        promptAgentRecharge(cause.toolErrorCode)
      }
      if (submitted && (!(cause instanceof AgentRequestError) || cause.status >= 500))
        setUncertain((previous) => new Set([...previous, generation.messageId]))
    } finally {
      try {
        const receipt = await read()
        if (receipt) await syncMessages([generation.messageId])
        const result = receipt?.generations.find((item) => item.messageId === generation.messageId)
        if (result && result.status !== 'awaiting_confirmation') {
          setUncertain(
            (previous) => new Set([...previous].filter((id) => id !== generation.messageId)),
          )
          setError(false)
        }
      } catch {
        setError(true)
      }
      inFlight.current = false
      setBusy(null)
    }
  }
  const taskAction = async (generation: ProductionGenerationView, cancel: boolean) => {
    if (inFlight.current) return
    inFlight.current = true
    readEpoch.current++
    setBusy(generation.messageId)
    setError(false)
    setFailureCode(undefined)
    try {
      if (cancel && generation.taskId) await cancelJob(conversationId, generation.taskId)
      else {
        const message = await retryToolCall(conversationId, generation.messageId, undefined)
        useAgentStore.getState().acceptGenerationReceipt(conversationId, message)
      }
    } catch {
      setError(true)
    } finally {
      try {
        const receipt = await read()
        if (receipt) await syncMessages(receipt.generations.map((item) => item.messageId))
      } catch {
        setError(true)
      }
      inFlight.current = false
      setBusy(null)
    }
  }
  const adopt = async (generation: ProductionGenerationView, artifact: AgentToolArtifact) => {
    if (inFlight.current) return
    inFlight.current = true
    readEpoch.current++
    setBusy(artifact.artifactId)
    setError(false)
    setFailureCode(undefined)
    try {
      const key = `${artifact.artifactId}:${document.revision}`
      const operationId = operations.current.get(key) ?? crypto.randomUUID()
      operations.current.set(key, operationId)
      const next = await adoptGeneration(conversationId, generation.draftId, {
        operationId,
        baseRevision: document.revision,
        artifactId: artifact.artifactId,
      })
      if (alive.current) onSaved({ ...next, history: [] })
    } catch {
      setError(true)
    } finally {
      inFlight.current = false
      setBusy(null)
    }
  }
  const candidates = generations.filter(
    (g) =>
      g.production.documentId === document.id &&
      g.production.target === target.kind &&
      g.production.targetId === target.id,
  )
  return (
    <section className="production-generations" aria-label={t('generation.title')}>
      <header>
        <strong>{t('generation.title')}</strong>
        <Button
          type="button"
          disabled={busy !== null || Boolean(preparationBlocked)}
          onClick={startCandidate}
        >
          {t('generation.new')}
        </Button>
        <Button type="button" onClick={() => setRetry((v) => v + 1)}>
          {t('generation.refresh')}
        </Button>
      </header>
      {preparationBlocked && <p role="status">{preparationBlocked}</p>}
      {creatingStale && <p role="status">{t('generation.sourceChanged')}</p>}
      {creating && (
        <ProductionGenerationEditor
          conversationId={conversationId}
          key={creatingRevision.current}
          value={creating}
          busy={busy !== null || Boolean(preparationBlocked) || creatingStale}
          submitLabel={t('generation.create')}
          onConfirm={(fields) => void create(fields)}
        />
      )}
      {error && <p role="alert">{agentToolFailureText(failureCode) ?? t('generation.failed')}</p>}
      {!candidates.length && !error && <p>{t('generation.empty')}</p>}
      {candidates.map((generation) => (
        <article
          className="production-generation"
          key={`${generation.draftId}:${generation.taskId ?? 'draft'}`}
        >
          <header>
            <strong>{t('generation.candidate', { number: generation.messageId.slice(-6) })}</strong>
            <span>
              {t(`generation.status.${generation.status}`, { defaultValue: generation.status })}
            </span>
          </header>
          {generation.sourceChanged && <p role="status">{t('generation.sourceChanged')}</p>}
          {generation.retryOf && (
            <small>
              {t('generation.retryFrom', { number: generation.retryOf.messageId.slice(-6) })}
            </small>
          )}
          {generation.errorCode && <p role="alert">{agentToolFailureText(generation.errorCode)}</p>}
          {generation.status === 'awaiting_confirmation' ? (
            uncertain.has(generation.messageId) ? (
              <p>{t('generation.unknown')}</p>
            ) : (
              <ProductionGenerationEditor
                conversationId={conversationId}
                key={`${generation.draftId}:${generation.draftRevision}`}
                value={generation}
                busy={
                  busy !== null || Boolean(preparationBlocked) || Boolean(generation.sourceChanged)
                }
                onConfirm={(fields) => void confirm(generation, fields)}
              />
            )
          ) : (
            <p>{generation.prompt}</p>
          )}
          {generation.status === 'failed' && (
            <Button
              type="button"
              disabled={busy !== null}
              onClick={() => void taskAction(generation, false)}
            >
              {t('generation.retry')}
            </Button>
          )}
          {(generation.status === 'queued' || generation.status === 'in_progress') &&
            generation.taskId && (
              <Button
                type="button"
                disabled={busy !== null}
                onClick={() => void taskAction(generation, true)}
              >
                {t('generation.cancel')}
              </Button>
            )}
          <small>
            {generation.model} · V{generation.production.revision}
            {generation.video &&
              ` · ${generation.video.duration_seconds}s · ${generation.video.aspect_ratio} · ${generation.video.resolution}`}
          </small>
          {generation.artifacts.map((artifact) => (
            <div className="production-generation-result" key={artifact.artifactId}>
              {onPreviewArtifact && artifact.media !== 'video' ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="h-auto p-0"
                  aria-label={t('generation.preview')}
                  onClick={() => onPreviewArtifact(generation, artifact)}
                >
                  <CandidatePreview artifact={artifact} />
                </Button>
              ) : (
                <CandidatePreview artifact={artifact} />
              )}
              {onPreviewArtifact && artifact.media === 'video' && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onPreviewArtifact(generation, artifact)}
                >
                  {t('generation.preview')}
                </Button>
              )}
              <Button
                type="button"
                disabled={busy !== null || adopted === artifact.artifactId}
                onClick={() => void adopt(generation, artifact)}
              >
                {t(adopted === artifact.artifactId ? 'generation.adopted' : 'generation.adopt')}
              </Button>
            </div>
          ))}
        </article>
      ))}
    </section>
  )
}
