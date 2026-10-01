import type { ProductionDocument, ProductionRevision } from '@image-playground/shared'
import {
  ChevronDown,
  FileText,
  History,
  ListCollapse,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react'
import { useState } from 'react'
import { Input } from '../../../components/ui/input'
import { Textarea } from '../../../components/ui/textarea'
import { useTranslation } from '../../../i18n'
import {
  fetchProductionHistory,
  type ProductionResponse,
  restoreProduction,
} from '../lib/productionClient'
import { useProductionEditor } from '../lib/useProductionEditor'

export type ProductionTab = 'setting' | 'outline' | 'scenes'

export default function ProductionDocumentPane({
  document,
  onClose,
  onSaved,
}: {
  document: ProductionDocument
  onClose: () => void
  onSaved: (next: ProductionResponse) => void
}) {
  const { t } = useTranslation('production')
  const [tab, setTab] = useState<ProductionTab>('scenes')
  const [collapsed, setCollapsed] = useState(false)
  const [history, setHistory] = useState<readonly ProductionRevision[] | null>(null)
  const [historyError, setHistoryError] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const edit = useProductionEditor(document, onSaved)
  const content = edit.content
  const showHistory = async () => {
    if (history) {
      setHistory(null)
      return
    }
    setHistoryError(false)
    try {
      setHistory((await fetchProductionHistory(document.conversationId)).history)
    } catch {
      setHistoryError(true)
    }
  }
  const restore = async (revision: number) => {
    setRestoring(true)
    setHistoryError(false)
    try {
      onSaved(
        await restoreProduction(
          document.conversationId,
          crypto.randomUUID(),
          document.revision,
          revision,
        ),
      )
      setHistory(null)
    } catch {
      setHistoryError(true)
    } finally {
      setRestoring(false)
    }
  }
  return (
    <section className="production-document" aria-label={t('document')}>
      <header className="production-pane-header">
        <span>
          <FileText size={17} />
          {document.content.title || t('untitled')}
        </span>
        <button type="button" aria-label={t('close')} onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <nav className="production-tabs" aria-label={t('sections')}>
        {(['setting', 'outline', 'scenes'] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={tab === value}
            onClick={() => setTab(value)}
          >
            {t(value)}
          </button>
        ))}
      </nav>
      <div className="production-document-tools">
        {edit.editing ? (
          <>
            <button
              type="button"
              className="production-primary"
              disabled={edit.saving}
              onClick={() => void edit.save()}
            >
              {t(edit.saving ? 'saving' : 'done')}
            </button>
            <button type="button" disabled={edit.saving} onClick={edit.keep}>
              {t('keepDraft')}
            </button>
            <button type="button" disabled={edit.saving} onClick={edit.discard}>
              {t('discard')}
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={edit.start}>
              <Pencil size={14} />
              {t('edit')}
            </button>
            <button type="button" onClick={() => setCollapsed(!collapsed)}>
              <ListCollapse size={14} />
              {t(collapsed ? 'expandAll' : 'collapseAll')}
            </button>
            <button type="button" aria-label={t('history')} onClick={() => void showHistory()}>
              <History size={15} />
            </button>
          </>
        )}
        <span>{t('revision', { revision: document.revision })}</span>
      </div>
      {edit.error && (
        <p className="production-error" role="alert">
          {t(edit.error)}
        </p>
      )}
      {historyError && (
        <p className="production-error" role="alert">
          {t('restoreFailed')}
        </p>
      )}
      {history && (
        <div className="production-history" aria-label={t('history')}>
          {history.length === 0
            ? t('emptyHistory')
            : [...history].reverse().map((revision) => (
                <div key={revision.revision}>
                  <span>
                    {t('revision', { revision: revision.revision })} ·{' '}
                    {t(`historySource.${revision.source}`)}
                  </span>
                  <button
                    type="button"
                    disabled={restoring || edit.editing || revision.revision === document.revision}
                    onClick={() => void restore(revision.revision)}
                  >
                    <RotateCcw size={13} />
                    {t('restore')}
                  </button>
                </div>
              ))}
        </div>
      )}
      <div className="production-document-scroll">
        <div className="production-document-heading">
          {edit.editing ? (
            <Input
              aria-label={t('title')}
              value={content.title}
              disabled={edit.saving}
              onChange={(event) => edit.update({ ...content, title: event.target.value })}
            />
          ) : (
            <h1>{content.title || t('untitled')}</h1>
          )}
        </div>
        {tab === 'scenes' ? (
          <>
            {content.scenes.map((scene, index) =>
              edit.editing ? (
                <div key={scene.id} className="production-scene-editor">
                  <div>
                    <span className="production-scene-number">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <Input
                      aria-label={t('sceneTitle')}
                      value={scene.title}
                      disabled={edit.saving}
                      onChange={(event) =>
                        edit.update({
                          ...content,
                          scenes: content.scenes.map((one) =>
                            one.id === scene.id ? { ...one, title: event.target.value } : one,
                          ),
                        })
                      }
                    />
                    <button
                      type="button"
                      aria-label={t('removeScene')}
                      disabled={edit.saving}
                      onClick={() =>
                        edit.update({
                          ...content,
                          scenes: content.scenes.filter((one) => one.id !== scene.id),
                        })
                      }
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                  <Textarea
                    aria-label={t('sceneBody')}
                    value={scene.body}
                    disabled={edit.saving}
                    onChange={(event) =>
                      edit.update({
                        ...content,
                        scenes: content.scenes.map((one) =>
                          one.id === scene.id ? { ...one, body: event.target.value } : one,
                        ),
                      })
                    }
                  />
                </div>
              ) : (
                <details
                  key={`${scene.id}:${collapsed}`}
                  open={!collapsed}
                  className="production-scene"
                >
                  <summary>
                    <ChevronDown size={14} />
                    <span className="production-scene-number">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    {scene.title}
                  </summary>
                  <p>{scene.body}</p>
                </details>
              ),
            )}
            {edit.editing && (
              <button
                type="button"
                className="production-add-scene"
                disabled={edit.saving}
                onClick={() =>
                  edit.update({
                    ...content,
                    scenes: [...content.scenes, { id: crypto.randomUUID(), title: '', body: '' }],
                  })
                }
              >
                <Plus size={15} />
                {t('addScene')}
              </button>
            )}
          </>
        ) : edit.editing ? (
          <Textarea
            className="production-prose-editor"
            aria-label={t(tab)}
            value={content[tab]}
            disabled={edit.saving}
            onChange={(event) => edit.update({ ...content, [tab]: event.target.value })}
          />
        ) : (
          <p className="production-prose">{content[tab] || t('emptySection')}</p>
        )}
      </div>
    </section>
  )
}
