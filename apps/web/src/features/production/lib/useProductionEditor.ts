import type { ProductionContent, ProductionDocument } from '@image-playground/shared'
import { useRef, useState } from 'react'
import { safeLocalStorage, scopedStorageName } from '../../../lib/authScope'
import { ProductionRequestError, type ProductionResponse, saveProduction } from './productionClient'

interface LocalDraft {
  content: ProductionContent
  baseRevision: number
  operationId: string
}

function readDraft(key: string): LocalDraft | null {
  try {
    const parsed = JSON.parse(safeLocalStorage.getItem(key) ?? 'null') as LocalDraft | null
    if (
      !parsed ||
      !Number.isSafeInteger(parsed.baseRevision) ||
      typeof parsed.operationId !== 'string' ||
      !parsed.content ||
      typeof parsed.content.title !== 'string' ||
      typeof parsed.content.setting !== 'string' ||
      typeof parsed.content.outline !== 'string' ||
      !Array.isArray(parsed.content.scenes)
    )
      return null
    if (
      !parsed.content.scenes.every(
        (scene) =>
          typeof scene.id === 'string' &&
          typeof scene.title === 'string' &&
          typeof scene.body === 'string',
      )
    )
      return null
    return parsed
  } catch {
    return null
  }
}

export function useProductionEditor(
  document: ProductionDocument,
  onSaved: (next: ProductionResponse) => void,
  draftScope?: string,
) {
  const key = scopedStorageName(
    `production-draft:${document.conversationId}:${document.id}${draftScope ? `:${draftScope}` : ''}`,
  )
  const [draft, setDraft] = useState<LocalDraft | null>(() => readDraft(key))
  const latestDraft = useRef(draft)
  latestDraft.current = draft
  const [editing, setEditing] = useState(() => readDraft(key) !== null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<'conflict' | 'saveFailed' | null>(null)
  const update = (content: ProductionContent) => {
    const next = {
      content,
      baseRevision: draft?.baseRevision ?? document.revision,
      operationId: crypto.randomUUID(),
    }
    setEditing(true)
    latestDraft.current = next
    setDraft(next)
    safeLocalStorage.setItem(key, JSON.stringify(next))
    setError(null)
  }
  const start = () => {
    if (!draft) update(structuredClone(document.content))
    setEditing(true)
  }
  const discard = () => {
    // An older mounted editor may receive its save after this draft was reopened and changed.
    if (readDraft(key)?.operationId === draft?.operationId) safeLocalStorage.removeItem(key)
    if (latestDraft.current?.operationId !== draft?.operationId) return
    latestDraft.current = null
    setDraft(null)
    setEditing(false)
    setError(null)
  }
  const save = async () => {
    if (!draft || saving) return
    setSaving(true)
    setError(null)
    try {
      const next = await saveProduction(document.conversationId, draft)
      onSaved(next)
      discard()
    } catch (failure) {
      setError(
        failure instanceof ProductionRequestError && failure.code === 'production_conflict'
          ? 'conflict'
          : 'saveFailed',
      )
    } finally {
      setSaving(false)
    }
  }
  return {
    content: editing && draft ? draft.content : document.content,
    draft,
    editing,
    saving,
    error,
    start,
    update,
    save,
    discard,
    keep: () => setEditing(false),
  }
}
