import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { CloseIcon } from '../../../components/icons'
import SuggestionMenu, { useSuggestionMenu } from '../../../components/SuggestionMenu'
import {
  getContentEditableCursor,
  getContentEditablePlainText,
  getContentEditableSelection,
  setContentEditableCursor,
  syncMentionTagSelection,
} from '../../../lib/promptEditorDom'
import { buildPromptEditorHtml } from '../../../lib/promptEditorHtml'
import {
  getAtImageQuery,
  getImageMentionLabel,
  getVisiblePrompt,
  isCursorInSelectedImageMention,
} from '../../../lib/promptImageMentions'
import { ensureAssetImage } from '../../../lib/sync/assetImages'
import { ensureImageCached } from '../../../store'
import type { CanvasDoc } from '../../canvas/lib/canvasDoc'
import { useLibraryStore } from '../../library/store'
import { ABORT_BUTTON, ICON_BUTTON, INK_3, SEND_BUTTON } from '../agentStyles'
import { type AgentMentionValue, buildAgentMentionGroups, canvasImages } from '../lib/agentMentions'
import {
  type AgentDraft,
  type AgentReference,
  attachReference,
  draftForSubmit,
  EMPTY_DRAFT,
  referenceLabels,
  removeReference,
} from '../lib/references'
import { useAgentStore } from '../store'

const EDITOR_CLASS =
  'max-h-28 w-full overflow-y-auto whitespace-pre-wrap break-words bg-transparent text-xs leading-relaxed text-[#e8e8ea] outline-none empty:before:pointer-events-none empty:before:text-[#5f5f68] empty:before:content-[attr(data-placeholder)]'

const STRIP_THUMB = 'h-10 w-10 overflow-hidden rounded-lg border border-white/[0.09] object-cover'

export default function AgentComposer({ doc }: { doc: CanvasDoc }) {
  const running = useAgentStore((state) => state.turn === 'running')
  const assets = useLibraryStore((state) => state.assets)
  const loadAssets = useLibraryStore((state) => state.loadAssets)
  const [draft, setDraft] = useState<AgentDraft>(EMPTY_DRAFT)
  const [cursor, setCursor] = useState(0)
  const editorRef = useRef<HTMLDivElement>(null)
  // 用户刚打进去的那个值不回写 DOM，否则每敲一个字光标都会跳到末尾。
  const typedRef = useRef<string | null>(null)

  // 素材名要参与 `@` 候选与胶囊标签，不能等到用户打开素材库才读。
  useEffect(() => {
    void loadAssets()
  }, [loadAssets])

  const labels = useMemo(() => referenceLabels(draft.references), [draft.references])
  const canvas = useMemo(() => canvasImages(doc), [doc])

  useEffect(() => {
    const typed = typedRef.current
    typedRef.current = null
    const el = editorRef.current
    if (!el || draft.prompt === typed) return
    const html = buildPromptEditorHtml(draft.prompt, labels, {})
    if (el.innerHTML !== html) el.innerHTML = html
  }, [draft.prompt, labels])

  const query = isCursorInSelectedImageMention(draft.prompt, cursor, labels)
    ? null
    : getAtImageQuery(getVisiblePrompt(draft.prompt, labels), cursor)
  const groups = query
    ? buildAgentMentionGroups({ query: query.query, references: draft.references, canvas, assets })
    : []

  const applyAttach = (reference: AgentReference, start: number, at: number) => {
    const next = attachReference(draft, reference, start, at)
    typedRef.current = null
    setDraft(next.draft)
    setCursor(next.cursor)
    window.setTimeout(() => {
      const el = editorRef.current
      if (!el) return
      el.focus()
      setContentEditableCursor(el, next.cursor)
    }, 0)
  }

  const selectMention = async (value: AgentMentionValue) => {
    const el = editorRef.current
    const at = el ? getContentEditableCursor(el) : cursor
    const active = getAtImageQuery(getVisiblePrompt(draft.prompt, labels), at)
    if (!active) return

    if (value.type === 'reference') {
      const reference = draft.references[value.index]
      if (reference) applyAttach(reference, active.start, at)
      return
    }
    if (value.type === 'canvas') {
      const image = canvas.find((one) => one.imageId === value.imageId)
      if (image) applyAttach({ id: image.imageId, dataUrl: image.dataUrl }, active.start, at)
      return
    }
    const asset = assets.find((one) => one.id === value.id)
    if (!asset) return
    await ensureAssetImage(asset.imageId)
    const dataUrl = await ensureImageCached(asset.imageId)
    if (!dataUrl) return
    applyAttach({ id: asset.imageId, dataUrl, name: asset.name }, active.start, at)
  }

  const menu = useSuggestionMenu({
    groups,
    onSelect: (value: AgentMentionValue) => void selectMention(value),
    onClose: () => editorRef.current?.blur(),
  })

  const submit = () => {
    const submission = draftForSubmit(draft)
    if (!submission.text.trim()) return
    setDraft(EMPTY_DRAFT)
    setCursor(0)
    if (editorRef.current) editorRef.current.innerHTML = ''
    void useAgentStore.getState().send(submission.text, submission.references)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (menu.handleKeyDown(event)) return
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    submit()
  }

  return (
    <div className="relative flex shrink-0 flex-col gap-2 px-3 pb-3 pt-2">
      {draft.references.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {draft.references.map((reference, index) => (
            <div key={reference.id} className="group relative">
              <img src={reference.dataUrl} className={STRIP_THUMB} alt="" />
              <span className={`block max-w-10 truncate pt-0.5 text-[10px] ${INK_3}`}>
                {reference.name ?? getImageMentionLabel(index)}
              </span>
              <button
                type="button"
                aria-label={`移除参考图 ${reference.name ?? getImageMentionLabel(index)}`}
                className={`absolute -right-1 -top-1 bg-[#17171a] opacity-0 group-hover:opacity-100 ${ICON_BUTTON}`}
                onClick={() => setDraft(removeReference(draft, index))}
              >
                <CloseIcon className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="relative rounded-xl border border-white/[0.09] bg-white/[0.05] px-2.5 py-2 focus-within:border-blue-500/50">
        {menu.visible && (
          <SuggestionMenu
            groups={groups}
            activeIndex={menu.activeIndex}
            offsetLeft={0}
            onActiveIndexChange={menu.setActiveIndex}
            onSelect={menu.select}
          />
        )}
        <div
          ref={editorRef}
          role="textbox"
          tabIndex={0}
          aria-label="对智能体说"
          contentEditable
          suppressContentEditableWarning
          data-placeholder="说一句你想做什么，@ 引用画布或素材"
          className={EDITOR_CLASS}
          onInput={(event) => {
            const el = event.currentTarget
            // 删完最后一个字后浏览器常留 <br>，:empty 不再匹配 → placeholder 消失。
            if (!el.textContent && el.innerHTML) el.innerHTML = ''
            const range = getContentEditableSelection(el)
            setCursor(range.start)
            syncMentionTagSelection(el)
            const text = getContentEditablePlainText(el)
            typedRef.current = text
            setDraft((current) => ({ ...current, prompt: text }))
            menu.open()
          }}
          onSelect={(event) => {
            const el = event.currentTarget
            setCursor(getContentEditableSelection(el).start)
            syncMentionTagSelection(el)
            menu.open()
          }}
          onKeyDown={onKeyDown}
        />
      </div>

      <div className="flex items-center justify-end gap-2">
        {running && (
          <button
            type="button"
            className={ABORT_BUTTON}
            onClick={() => void useAgentStore.getState().abort()}
          >
            中止
          </button>
        )}
        <button
          type="button"
          className={SEND_BUTTON}
          disabled={!draft.prompt.trim()}
          onClick={submit}
        >
          {running ? '插话' : '发送'}
        </button>
      </div>
    </div>
  )
}
