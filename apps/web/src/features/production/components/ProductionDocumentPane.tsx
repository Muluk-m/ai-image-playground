import type {
  ProductionContext,
  ProductionDocument,
  ProductionRevision,
} from '@image-playground/shared'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import SegmentedTabs from '../../../components/patterns/SegmentedTabs'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { Input } from '../../../components/ui/input'
import { Textarea } from '../../../components/ui/textarea'
import { useTranslation } from '../../../i18n'
import {
  fetchProductionHistory,
  type ProductionResponse,
  restoreProduction,
} from '../lib/productionClient'
import { setProductionPanelContext } from '../lib/productionContext'
import { useProductionEditor } from '../lib/useProductionEditor'
import { type ProductionTab, useProductionReading } from '../lib/useProductionReading'
import ProductionDeleteImpactNotice from './ProductionDeleteImpactNotice'
import ProductionProposals from './ProductionProposals'
import ProductionQuotableText from './ProductionQuotableText'

export type { ProductionTab } from '../lib/useProductionReading'

export default function ProductionDocumentPane({
  document,
  onClose,
  onSaved,
  refreshKey = '',
}: {
  document: ProductionDocument
  refreshKey?: string
  onClose: () => void
  onSaved: (next: ProductionResponse) => void
}) {
  const { t } = useTranslation('production')
  const [removeSceneId, setRemoveSceneId] = useState<string | null>(null)
  const { position, update: updatePosition } = useProductionReading(
    document.conversationId,
    document.id,
  )
  const tab = position.tab
  const setTab = (next: ProductionTab) => updatePosition((current) => ({ ...current, tab: next }))
  const collapsed =
    document.content.scenes.length > 0 &&
    document.content.scenes.every((scene) => position.closedScenes.includes(scene.id))
  const setCollapsed = (next: boolean) =>
    updatePosition((current) => ({
      ...current,
      closedScenes: next ? document.content.scenes.map((scene) => scene.id) : [],
    }))
  const scroll = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (scroll.current) scroll.current.scrollTop = position.scroll[tab]
  }, [tab])
  const [history, setHistory] = useState<readonly ProductionRevision[] | null>(null)
  const [historyError, setHistoryError] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const edit = useProductionEditor(document, onSaved)
  const content = edit.content
  useEffect(() => {
    if (!edit.editing) setRemoveSceneId(null)
  }, [edit.editing])
  useEffect(() => {
    setProductionPanelContext(
      document.conversationId,
      tab === 'scenes'
        ? null
        : { documentId: document.id, revision: document.revision, target: tab },
    )
    return () => setProductionPanelContext(document.conversationId, null)
  }, [document, tab])
  useEffect(() => {
    const locate = (event: Event) => {
      const detail = (event as CustomEvent<{ conversationId: string; context?: ProductionContext }>)
        .detail
      const context = detail.context
      if (detail.conversationId !== document.conversationId || !context) return
      if (
        context.target !== 'scene' &&
        context.target !== 'setting' &&
        context.target !== 'outline'
      )
        return
      setTab(context.target === 'scene' ? 'scenes' : context.target)
      setCollapsed(false)
      requestAnimationFrame(() => {
        const node = globalThis.document.querySelector<HTMLElement>(
          `[data-production-text="${CSS.escape(context.sceneId ?? context.target)}"]`,
        )
        node?.scrollIntoView?.({ block: 'center' })
        node?.focus()
      })
    }
    window.addEventListener('production:locate', locate)
    return () => window.removeEventListener('production:locate', locate)
  }, [document.conversationId])
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
          <Icon name="script" />
          {document.content.title || t('untitled')}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          type="button"
          aria-label={t('close')}
          onClick={onClose}
        >
          <Icon name="close" />
        </Button>
      </header>
      <div className="production-tabs">
        <SegmentedTabs
          label={t('sections')}
          value={tab}
          onChange={setTab}
          tabs={(['setting', 'outline', 'scenes'] as const).map((value) => ({
            value,
            label: t(value),
          }))}
        />
      </div>
      <div className="production-document-tools">
        {edit.editing ? (
          <>
            <Button
              variant="default"
              size="sm"
              type="button"
              disabled={edit.saving}
              onClick={() => void edit.save()}
            >
              {t(edit.saving ? 'saving' : 'done')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              disabled={edit.saving}
              onClick={edit.keep}
            >
              {t('keepDraft')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              disabled={edit.saving}
              onClick={edit.discard}
            >
              {t('discard')}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="sm" type="button" onClick={edit.start}>
              <Icon name="edit" />
              {t('edit')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => setCollapsed(!collapsed)}
            >
              <Icon name="collapseAll" />
              {t(collapsed ? 'expandAll' : 'collapseAll')}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              type="button"
              aria-label={t('history')}
              onClick={() => void showHistory()}
            >
              <Icon name="history" />
            </Button>
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
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    disabled={restoring || edit.editing || revision.revision === document.revision}
                    onClick={() => void restore(revision.revision)}
                  >
                    <Icon name="undo" />
                    {t('restore')}
                  </Button>
                </div>
              ))}
        </div>
      )}
      <ProductionProposals
        document={document}
        refreshKey={refreshKey}
        onSaved={onSaved}
        editing={edit.editing}
      />
      <div
        className="production-document-scroll"
        ref={scroll}
        onScroll={(event) => {
          const top = event.currentTarget.scrollTop
          updatePosition((current) => ({ ...current, scroll: { ...current.scroll, [tab]: top } }))
        }}
      >
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
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      type="button"
                      aria-label={t('removeScene')}
                      disabled={edit.saving}
                      onClick={() => setRemoveSceneId(scene.id)}
                    >
                      <Icon name="delete" />
                    </Button>
                  </div>
                  {removeSceneId === scene.id && (
                    <div className="production-scene-delete" role="alert">
                      <ProductionDeleteImpactNotice
                        content={content}
                        target={{ kind: 'scene', id: scene.id }}
                      />
                      <div className="production-reference-actions">
                        <Button
                          variant="destructive"
                          size="sm"
                          type="button"
                          disabled={edit.saving}
                          onClick={() => {
                            edit.update({
                              ...content,
                              scenes: content.scenes.filter((one) => one.id !== scene.id),
                            })
                            setRemoveSceneId(null)
                          }}
                        >
                          {t('asset.deleteConfirm')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          type="button"
                          disabled={edit.saving}
                          onClick={() => setRemoveSceneId(null)}
                        >
                          {t('cancel')}
                        </Button>
                      </div>
                    </div>
                  )}
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
                  key={scene.id}
                  open={!position.closedScenes.includes(scene.id)}
                  onToggle={(event) => {
                    const open = event.currentTarget.open
                    if (open === !position.closedScenes.includes(scene.id)) return
                    updatePosition((current) => ({
                      ...current,
                      closedScenes: open
                        ? current.closedScenes.filter((id) => id !== scene.id)
                        : [...new Set([...current.closedScenes, scene.id])],
                    }))
                  }}
                  className="production-scene"
                >
                  <summary>
                    <Icon name="chevronDown" />
                    <span className="production-scene-number">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    {scene.title}
                  </summary>
                  <ProductionQuotableText
                    document={document}
                    target="scene"
                    sceneId={scene.id}
                    text={scene.body}
                  />
                </details>
              ),
            )}
            {edit.editing && (
              <Button
                variant="ghost"
                size="sm"
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
                <Icon name="add" />
                {t('addScene')}
              </Button>
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
          <ProductionQuotableText
            document={document}
            target={tab}
            text={content[tab]}
            className="production-prose"
          />
        )}
      </div>
    </section>
  )
}
