import {
  type ClipboardEvent,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import {
  Composer,
  ComposerActions,
  ComposerAttachButton,
  ComposerAttachments,
  ComposerBar,
  ComposerSend,
  ComposerToolbar,
} from '../../../components/assistant-ui/elements/composer'
import { CloseIcon, MaskBrushIcon } from '../../../components/icons'
import SuggestionMenu, { useSuggestionMenu } from '../../../components/SuggestionMenu'
import { useImageDropZone } from '../../../hooks/useImageDropZone'
import { acceptImageFiles } from '../../../lib/imageFiles'
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
import { ensureImageCached, useStore } from '../../../store'
import type { CanvasDoc, ImageEl } from '../../canvas/lib/canvasDoc'
import { canvasSceneKey } from '../../canvas/lib/workspaces'
import { currentCanvasProject } from '../../canvas/projectStore'
import { useLibraryStore } from '../../library/store'
import { ABORT_BUTTON, ICON_BUTTON } from '../agentStyles'
import { type AgentMentionValue, buildAgentMentionGroups, canvasImages } from '../lib/agentMentions'
import { attachReferences, filesToReferences, setAgentComposerAttach } from '../lib/attachments'
import { agentDraft } from '../lib/drafts'
import { type MarkRenderer, renderMarkedImage, selectedMarkIds } from '../lib/markedReferences'
import {
  type AgentReference,
  attachReference,
  clearReferenceMask,
  draftForSubmit,
  referenceLabels,
  removeReference,
  setReferenceMask,
  syncSelectedReferences,
} from '../lib/references'
import { useAgentStore } from '../store'
import AgentParamsChip from './AgentParamsChip'

const EDITOR_CLASS =
  'min-h-16 max-h-44 w-full overflow-y-auto whitespace-pre-wrap break-words bg-transparent px-1 pt-1 text-sm leading-relaxed text-foreground outline-none empty:before:pointer-events-none empty:before:text-muted-foreground empty:before:content-[attr(data-placeholder)]'

const STRIP_THUMB = 'h-8 w-8 shrink-0 overflow-hidden rounded-md object-cover'

export default function AgentComposer({
  doc,
  editor,
  welcome = false,
}: {
  welcome?: boolean
  doc: CanvasDoc
  /** 把选中的批注烧进参考图要它来栅格化；没有就只带原图。 */
  editor?: MarkRenderer
}) {
  const historyBlocked = useAgentStore((state) => state.historyLoading || state.historyFailed)
  const running = useAgentStore((state) => state.turn === 'running')
  const assets = useLibraryStore((state) => state.assets)
  const loadAssets = useLibraryStore((state) => state.loadAssets)
  const conversationId = useAgentStore((state) => state.conversationId)
  const project = currentCanvasProject()
  const session = agentDraft(
    conversationId,
    project?.id,
    project?.sceneKey === canvasSceneKey(null),
  )
  const {
    draft,
    loading,
    submitting,
    error: draftError,
  } = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const setDraft = session.update
  useEffect(() => {
    const flush = () => {
      void session.flush()
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', flush)
    return () => {
      flush()
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', flush)
    }
  }, [session])
  const [cursor, setCursor] = useState(0)
  const editorRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 拖进来、粘贴进来、点回形针选进来的图片都走这一条：读文件 → 压缩 → 进引用区。
  const attachFiles = (files: File[]) => {
    if (loading) {
      useStore.getState().showToast('草稿正在恢复，请稍后添加图片。', 'info')
      return
    }
    const images = acceptImageFiles(files)
    if (images.length === 0) return
    void filesToReferences(images).then((added) => {
      setDraft((current) => attachReferences(current, added))
    })
  }
  const { dragging, dropZoneProps } = useImageDropZone(attachFiles)
  // 面板把落在对话记录上的文件递过来。
  useEffect(() => {
    setAgentComposerAttach(attachFiles)
    return () => setAgentComposerAttach(null)
  })
  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const files = [...event.clipboardData.files]
    if (files.length === 0) return
    event.preventDefault()
    attachFiles(files)
  }
  // 用户刚打进去的那个值不回写 DOM，否则每敲一个字光标都会跳到末尾。
  const typedRef = useRef<string | null>(null)

  // 素材名要参与 `@` 候选与胶囊标签，不能等到用户打开素材库才读。
  useEffect(() => {
    void loadAssets()
  }, [loadAssets])

  const labels = useMemo(() => referenceLabels(draft.references), [draft.references])
  const version = useSyncExternalStore(doc.subscribe, () => doc.version)
  const canvas = useMemo(() => canvasImages(doc), [doc, version])

  // 画布上选中的图直接进引用区：选了几张就是要对这几张说话，不必再逐张 `@`。
  // 自动带进来的按 id 记着，取消选中就撤走；用户手动 `@` 进来的不归它管。
  // 每张选中的图带上压在它上面、也被选中的批注：用户圈了一块，模型就该看到那个圈。
  const selectedImages = useMemo(
    () =>
      canvas.flatMap((image) => {
        if (!doc.selection.has(image.imageId)) return []
        const element = doc.elements.find((el) => el.id === image.imageId)
        if (element?.type !== 'image') return []
        return [{ imageId: image.imageId, element, marks: selectedMarkIds(doc, element) }]
      }),
    [canvas, doc, version],
  )
  const selectionKey = selectedImages
    .map((one) => `${one.imageId}:${one.marks.join(',')}`)
    .join(' ')
  const autoRef = useRef<Set<string>>(new Set())
  const selectionKeyRef = useRef(selectionKey)
  selectionKeyRef.current = selectionKey
  useEffect(() => {
    if (loading) return
    const selected = new Set(selectedImages.map((one) => one.imageId))
    // 先按原图同步（去掉批注的那一刻立刻回到原图），烧了批注的版本随后替换进来。
    setDraft((current) => syncSelectedReferences(current, canvas, selected, autoRef.current))
    if (!editor) return
    for (const { imageId, element, marks } of selectedImages) {
      // 是否自动带进来的要等上面那个 updater 跑过才知道，所以在替换那一步再判。
      if (marks.length === 0) continue
      void renderMarkedImage(editor, element as ImageEl, marks).then((dataUrl) => {
        // 渲完之前选区又变了：这张图的批注不再是这一组，丢掉。
        if (!dataUrl || selectionKeyRef.current !== selectionKey) return
        setDraft((current) => ({
          ...current,
          references: current.references.map((one) =>
            one.id === imageId && autoRef.current.has(imageId) ? { ...one, dataUrl } : one,
          ),
        }))
      })
    }
    // 只在选区（含批注）变化时同步；canvas 的引用变化不该触发（那会把手动移除的又加回来）。
  }, [selectionKey, loading, session])

  // contentEditable 的 onSelect 不可靠，光标位置只能靠 selectionchange 跟。
  useEffect(() => {
    const onSelectionChange = () => {
      const el = editorRef.current
      const selection = window.getSelection()
      if (!el || !selection?.rangeCount) return
      try {
        if (!selection.getRangeAt(0).intersectsNode(el)) return
      } catch {
        return
      }
      setCursor(getContentEditableSelection(el).start)
      syncMentionTagSelection(el)
    }
    document.addEventListener('selectionchange', onSelectionChange)
    return () => document.removeEventListener('selectionchange', onSelectionChange)
  }, [])

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
    // 读素材库工具按「最近用过」排序，不记这一笔它就永远看不见智能体这边的使用。
    void useLibraryStore.getState().noteAssetUsed(asset.id)
    applyAttach({ id: asset.imageId, dataUrl, name: asset.name }, active.start, at)
  }

  const menu = useSuggestionMenu({
    groups,
    onSelect: (value: AgentMentionValue) => void selectMention(value),
    onClose: () => editorRef.current?.blur(),
  })

  /**
   * 遮罩编辑器是工作台那台，这里只借会话：图直接交过去（画布对象的 id 进不了图片存储），
   * 画完的遮罩回到这份草稿里，工作台自己的遮罩草稿一概不动。
   */
  const editMask = (reference: AgentReference) => {
    useStore.getState().openMaskEditorSession(reference.id, {
      maskDataUrl: reference.maskDataUrl ?? null,
      keepSemantics: false,
      targetDataUrl: reference.dataUrl,
      onSave: ({ maskDataUrl, targetDataUrl }) => {
        setDraft((current) =>
          setReferenceMask(current, reference.id, { maskDataUrl, dataUrl: targetDataUrl }),
        )
      },
      onRemove: () => {
        setDraft((current) => clearReferenceMask(current, reference.id))
      },
    })
  }

  const submit = () => {
    if (loading || submitting || historyBlocked) return
    const submission = draftForSubmit(draft)
    if (!submission.text.trim()) return
    // 乐观发送：敲下回车输入框立刻清空，那句话已经在对话里了；服务端没收下再把草稿放回来。
    const snapshot = draft
    session.accept(snapshot)
    setCursor(0)
    const releaseSubmission = session.beginSubmission()
    let accepted = false
    const restore = () => {
      useStore.getState().showToast('消息未发送成功，草稿已放回输入框，请重试。', 'error')
      // 这几秒里用户要是已经开始打下一句，别把它冲掉。
      setDraft((current) =>
        current.prompt.trim() || current.references.length ? current : snapshot,
      )
    }
    void useAgentStore
      .getState()
      .send(submission.text, submission.references, () => {
        accepted = true
        releaseSubmission()
      })
      .then(
        () => {
          if (!accepted) restore()
        },
        () => restore(),
      )
      .finally(releaseSubmission)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (menu.handleKeyDown(event)) return
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    submit()
  }

  return (
    <Composer
      className={`studio-agent-composer shrink-0 ${welcome ? 'w-full' : 'px-3 pb-3 pt-2'}`}
      {...dropZoneProps}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-1 z-20 grid place-items-center rounded-xl border border-dashed border-primary/70 bg-sidebar/90 text-xs text-primary">
          松开即作为参考图
        </div>
      )}
      {draftError && (
        <p role="alert" className="text-xs text-warning">
          {draftError}
        </p>
      )}
      <ComposerBar dragActive={dragging}>
        {draft.references.length > 0 && (
          <ComposerAttachments>
            {draft.references.map((reference, index) => {
              const label = reference.name ?? getImageMentionLabel(index)
              const masked = Boolean(reference.maskDataUrl)
              return (
                <div
                  key={reference.id}
                  className="group flex max-w-full items-center gap-2 rounded-lg border border-border bg-muted/60 p-1 pr-1.5"
                >
                  <div className="relative">
                    <img
                      src={reference.dataUrl}
                      className={`${STRIP_THUMB} ${masked ? 'ring-1 ring-ring/70' : ''}`}
                      alt=""
                    />
                    {masked && (
                      <span className="pointer-events-none absolute left-0.5 top-0.5 rounded bg-primary/90 px-1 py-px text-[7px] font-bold leading-none tracking-wider text-primary-foreground">
                        MASK
                      </span>
                    )}
                  </div>
                  <span className="max-w-28 truncate text-xs text-foreground">{label}</span>
                  <button
                    type="button"
                    aria-label={masked ? `修改参考图 ${label} 的遮罩` : `给参考图 ${label} 画遮罩`}
                    className={`shrink-0 ${ICON_BUTTON}`}
                    onClick={() => editMask(reference)}
                  >
                    <MaskBrushIcon className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    aria-label={`移除参考图 ${label}`}
                    className={`shrink-0 ${ICON_BUTTON}`}
                    onClick={() => setDraft(removeReference(draft, index))}
                  >
                    <CloseIcon className="h-3 w-3" />
                  </button>
                </div>
              )
            })}
          </ComposerAttachments>
        )}

        <div className="relative">
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
            contentEditable={!loading}
            aria-busy={loading}
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
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
        </div>

        <ComposerToolbar className="gap-2">
          <div className="flex min-w-0 items-center gap-1">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              aria-label="选择参考图"
              onChange={(event) => {
                attachFiles([...(event.currentTarget.files ?? [])])
                event.currentTarget.value = ''
              }}
            />
            <ComposerAttachButton
              aria-label="添加参考图"
              title="添加参考图（也可以拖进来或粘贴）"
              disabled={loading}
              onClick={() => fileInputRef.current?.click()}
            />
          </div>
          <ComposerActions className="min-w-0">
            <AgentParamsChip />
            {running && (
              <button
                type="button"
                className={ABORT_BUTTON}
                onClick={() => void useAgentStore.getState().abort()}
              >
                中止
              </button>
            )}
            <ComposerSend
              streaming={false}
              idle={!historyBlocked && !loading && !submitting && Boolean(draft.prompt.trim())}
              aria-label={submitting ? '发送中…' : running ? '插话' : '发送并创作'}
              title={running ? '插话' : '发送并创作'}
              disabled={historyBlocked || loading || submitting || !draft.prompt.trim()}
              onClick={submit}
            />
          </ComposerActions>
        </ComposerToolbar>
      </ComposerBar>
    </Composer>
  )
}
