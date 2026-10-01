import type {
  AgentToolArtifact,
  ProductionDocument,
  ProductionGenerationView,
} from '@image-playground/shared'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from '../../../i18n'
import { getStoredChannels } from '../../../lib/channels/channelStore'
import { queueOutputUrl } from '../../../lib/channels/queueClient'
import {
  AgentRequestError,
  cancelJob,
  confirmToolPrompt,
  retryToolCall,
} from '../../agent/lib/agentClient'
import { previewArtifactBitmap } from '../../agent/lib/artifactSource'
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

export default function ProductionGenerations({
  conversationId,
  document,
  target,
  onSaved,
  refreshKey = '',
  initialDraft,
  preparationBlocked,
  adoptedArtifactId,
}: {
  conversationId: string
  document: ProductionDocument
  target: { kind: 'look' | 'location' | 'clip'; id: string }
  onSaved: (next: ProductionResponse) => void
  refreshKey?: string
  initialDraft?: GenerationFields
  preparationBlocked?: string
  adoptedArtifactId?: string
}) {
  const { t } = useTranslation('production')
  const [generations, setGenerations] = useState<readonly ProductionGenerationView[]>([])
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [uncertain, setUncertain] = useState<ReadonlySet<string>>(new Set())
  const inFlight = useRef(false)
  const [creating, setCreating] = useState<GenerationFields | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const operations = useRef(new Map<string, string>())
  useEffect(() => {
    const controller = new AbortController()
    void listGenerations(conversationId, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) {
          setGenerations(next.generations)
          setError(false)
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true)
      })
    return () => controller.abort()
  }, [conversationId, document.revision, refreshKey, retry])
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
    if (inFlight.current || preparationBlocked) return
    inFlight.current = true
    setBusy('new')
    setError(false)
    try {
      const key = JSON.stringify({ revision: document.revision, target, fields })
      const operationId = operations.current.get(key) ?? crypto.randomUUID()
      operations.current.set(key, operationId)
      const next = await createGeneration(conversationId, {
        ...fields,
        operationId,
        baseRevision: document.revision,
        target: target.kind,
        targetId: target.id,
      })
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
    if (inFlight.current || preparationBlocked) return
    inFlight.current = true
    setBusy(generation.draftId)
    setError(false)
    let submitted = false
    try {
      const saved = await editGeneration(
        conversationId,
        generation.draftId,
        generation.draftRevision,
        fields,
      )
      submitted = true
      await confirmToolPrompt(
        conversationId,
        generation.messageId,
        saved.generation.prompt,
        undefined,
        saved.generation.draftRevision,
      )
    } catch (cause) {
      setError(true)
      if (submitted && (!(cause instanceof AgentRequestError) || cause.status >= 500))
        setUncertain((previous) => new Set([...previous, generation.messageId]))
    } finally {
      try {
        const receipt = await listGenerations(conversationId)
        setGenerations(receipt.generations)
        const result = receipt.generations.find((item) => item.messageId === generation.messageId)
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
    setBusy(generation.messageId)
    setError(false)
    try {
      if (cancel && generation.taskId) await cancelJob(conversationId, generation.taskId)
      else await retryToolCall(conversationId, generation.messageId, undefined)
    } catch {
      setError(true)
    } finally {
      try {
        const receipt = await listGenerations(conversationId)
        if (alive.current) setGenerations(receipt.generations)
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
    setBusy(artifact.artifactId)
    setError(false)
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
        <button
          type="button"
          disabled={busy !== null || Boolean(preparationBlocked)}
          onClick={startCandidate}
        >
          {t('generation.new')}
        </button>
        <button type="button" onClick={() => setRetry((v) => v + 1)}>
          {t('generation.refresh')}
        </button>
      </header>
      {preparationBlocked && <p role="status">{preparationBlocked}</p>}
      {creating && (
        <ProductionGenerationEditor
          conversationId={conversationId}
          value={creating}
          busy={busy !== null || Boolean(preparationBlocked)}
          submitLabel={t('generation.create')}
          onConfirm={(fields) => void create(fields)}
        />
      )}
      {error && <p role="alert">{t('generation.failed')}</p>}
      {!candidates.length && !error && <p>{t('generation.empty')}</p>}
      {candidates.map((generation, index) => (
        <article
          className="production-generation"
          key={`${generation.draftId}:${generation.taskId ?? 'draft'}`}
        >
          <header>
            <strong>{t('generation.candidate', { number: index + 1 })}</strong>
            <span>
              {t(`generation.status.${generation.status}`, { defaultValue: generation.status })}
            </span>
          </header>
          {generation.status === 'awaiting_confirmation' ? (
            uncertain.has(generation.messageId) ? (
              <p>{t('generation.unknown')}</p>
            ) : (
              <ProductionGenerationEditor
                conversationId={conversationId}
                key={`${generation.draftId}:${generation.draftRevision}`}
                value={generation}
                busy={busy !== null || Boolean(preparationBlocked)}
                onConfirm={(fields) => void confirm(generation, fields)}
              />
            )
          ) : (
            <p>{generation.prompt}</p>
          )}
          {generation.status === 'failed' && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void taskAction(generation, false)}
            >
              {t('generation.retry')}
            </button>
          )}
          {(generation.status === 'queued' || generation.status === 'in_progress') &&
            generation.taskId && (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void taskAction(generation, true)}
              >
                {t('generation.cancel')}
              </button>
            )}
          <small>
            {generation.model} · V{generation.production.revision}
            {generation.video &&
              ` · ${generation.video.duration_seconds}s · ${generation.video.aspect_ratio} · ${generation.video.resolution}`}
          </small>
          {generation.artifacts.map((artifact) => (
            <div className="production-generation-result" key={artifact.artifactId}>
              <CandidatePreview artifact={artifact} />
              <button
                type="button"
                disabled={busy !== null || adopted === artifact.artifactId}
                onClick={() => void adopt(generation, artifact)}
              >
                {t(adopted === artifact.artifactId ? 'generation.adopted' : 'generation.adopt')}
              </button>
            </div>
          ))}
        </article>
      ))}
    </section>
  )
}
