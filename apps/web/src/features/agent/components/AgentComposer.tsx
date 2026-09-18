import { ImageIcon, VideoIcon } from 'lucide-react'
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
import MediaImage from '../../../components/MediaImage'
import SuggestionMenu, {
  type SuggestionMenuGroup,
  useSuggestionMenu,
} from '../../../components/SuggestionMenu'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select'
import { useImageDropZone } from '../../../hooks/useImageDropZone'
import { useTranslation } from '../../../i18n'
import { isVideoModeAvailable } from '../../../lib/channels/videoChannels'
import { mediaIdentity, resolveMediaSource } from '../../../lib/cloudMedia'
import { acceptImageFiles } from '../../../lib/imageFiles'
import {
  getContentEditableCursor,
  getContentEditablePlainText,
  getContentEditableSelection,
  setContentEditableCursor,
  setContentEditableSelection,
  syncMentionTagSelection,
} from '../../../lib/promptEditorDom'
import {
  getAtImageQuery,
  getImageMentionLabel,
  getVisiblePrompt,
  isCursorInSelectedImageMention,
} from '../../../lib/promptImageMentions'
import { useStore } from '../../../store'
import type { CanvasDoc } from '../../canvas/lib/canvasDoc'
import { useLibraryStore } from '../../library/store'
import { ABORT_BUTTON, CARD_NOTE, GHOST_LINK, ICON_BUTTON } from '../agentStyles'
import {
  type AgentMentionValue,
  buildAgentMentionGroups,
  type CanvasImage,
  canvasImages,
} from '../lib/agentMentions'
import {
  applySkillCommand,
  buildAgentSkillGroups,
  getSlashSkillQuery,
} from '../lib/agentSkillMentions'
import {
  assetToReference,
  attachReferences,
  filesToReferences,
  setAgentComposerAttach,
} from '../lib/attachments'
import { setAgentComposerFill } from '../lib/composerFill'
import type { MarkRenderer } from '../lib/markedReferences'
import { currentProjectDraft } from '../lib/projectLifecycle'
import {
  type AgentReference,
  attachReference,
  clearReferenceMask,
  draftForSubmit,
  draftMode,
  hasDraftContent,
  referenceLabels,
  removeReference,
  setReferenceMask,
} from '../lib/references'
import { createSelectionReferences } from '../lib/selectionReferences'
import { useAgentSkills } from '../lib/useAgentSkills'
import { useAgentStore } from '../store'
import AgentEditorMentions from './AgentEditorMentions'
import AgentParamsChip from './AgentParamsChip'

const EDITOR_CLASS =
  'min-h-16 max-h-44 w-full overflow-y-auto whitespace-pre-wrap break-words bg-transparent px-1 pt-1 text-sm leading-relaxed text-foreground outline-none empty:before:pointer-events-none empty:before:text-muted-foreground empty:before:content-[attr(data-placeholder)]'

const STRIP_THUMB = 'h-8 w-8 shrink-0 overflow-hidden rounded-md object-cover'

/** `@` 与 `/` 两个弹层共用一个菜单，所以候选身份要能分得出是哪一支。 */
type ComposerSuggestion = AgentMentionValue | { readonly type: 'skill'; readonly name: string }

/** 画布对象 → 参考图：位图就在画布文档里，不必回存储里找。 */
function canvasReference(
  canvas: readonly CanvasImage[],
  imageId: string,
): AgentReference | undefined {
  const image = canvas.find((one) => one.imageId === imageId)
  return image && { id: image.imageId, dataUrl: image.dataUrl }
}

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
  const { t, i18n } = useTranslation('agent')
  const historyBlocked = useAgentStore((state) => state.historyLoading || state.historyFailed)
  const running = useAgentStore((state) => state.turn === 'running')
  const stopping = useAgentStore((state) => state.stopping)
  const assets = useLibraryStore((state) => state.assets)
  const loadAssets = useLibraryStore((state) => state.loadAssets)
  const conversationId = useAgentStore((state) => state.conversationId)
  const session = currentProjectDraft(conversationId)
  const {
    draft,
    loading,
    submitting,
    error: draftError,
    unsent,
  } = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const setDraft = session.update
  // 卸载即落盘。页面隐藏时的冲盘不在这里：草稿活得比输入框久，那一笔由 `drafts.ts` 自己登记。
  useEffect(
    () => () => {
      void session.flush()
    },
    [session],
  )
  const [cursor, setCursor] = useState(0)
  const [pasteVersion, setPasteVersion] = useState(0)
  const editorRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 拖进来、粘贴进来、点回形针选进来的图片都走这一条：读文件 → 压缩 → 进引用区。
  const attachFiles = (files: File[]) => {
    if (loading) {
      useStore.getState().showToast(t('composer.draftLoadingToast'), 'info')
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
  // 上一次由示例建议填进来的整句话；用户动过之后就不再算「建议」。
  const suggestedRef = useRef<string | null>(null)
  // 示例建议点进来的整句话：光标放到句末，等用户自己发。
  // 只换掉空草稿或上一条原样未动的建议；用户自己写的话（包括恢复的未发草稿）一个字都不动。
  const fillText = (text: string) => {
    if (loading) {
      useStore.getState().showToast(t('composer.draftLoadingToast'), 'info')
      return
    }
    const current = session.getSnapshot().draft.prompt
    if (current.trim() !== '' && current !== suggestedRef.current) {
      useStore.getState().showToast(t('suggestions.draftKeptToast'), 'info')
      return
    }
    suggestedRef.current = text
    typedRef.current = null
    setDraft((current) => ({ ...current, prompt: text }))
    setCursor(text.length)
    window.setTimeout(() => {
      const el = editorRef.current
      if (!el) return
      el.focus()
      setContentEditableCursor(el, text.length)
    }, 0)
  }
  useEffect(() => setAgentComposerFill(fillText))
  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const files = [...event.clipboardData.files]
    if (files.length > 0) {
      event.preventDefault()
      attachFiles(files)
      return
    }
    event.preventDefault()
    document.execCommand('insertText', false, event.clipboardData.getData('text/plain'))
    // Pasted canonical tokens need previews even though the input event came from typing.
    typedRef.current = null
    setPasteVersion((version) => version + 1)
  }
  // 用户刚打进去的那个值不回写 DOM，否则每敲一个字光标都会跳到末尾。
  const typedRef = useRef<string | null>(null)
  const composingRef = useRef(false)

  const copySelection = (event: ClipboardEvent<HTMLDivElement>) => {
    const selection = window.getSelection()
    if (!selection?.rangeCount || selection.isCollapsed) return false
    const el = event.currentTarget
    setContentEditableSelection(el, getContentEditableSelection(el))
    const fragment = document.createElement('div')
    fragment.append(selection.getRangeAt(0).cloneContents())
    event.clipboardData.setData('text/plain', getContentEditablePlainText(fragment))
    event.preventDefault()
    return true
  }

  // 素材名要参与 `@` 候选与胶囊标签，不能等到用户打开素材库才读。
  useEffect(() => {
    void loadAssets()
  }, [loadAssets])

  // 序号胶囊的显示标签随界面语言变，下游按这份解析器缓存的渲染要跟着重算。
  const labels = useMemo(() => referenceLabels(draft.references), [draft.references, i18n.language])
  const version = useSyncExternalStore(doc.subscribe, () => doc.version)
  // `@` 候选里的「画布图 n」是界面文案，切语言要跟着换，所以语言也是这份缓存的入参。
  const canvas = useMemo(() => canvasImages(doc), [doc, version, i18n.language])

  // 画布上选中的图直接进引用区：选了几张就是要对这几张说话，不必再逐张 `@`。
  // 哪些是这么带进来的归 selection 自己记，输入框只管把画布和草稿的入口交给它。
  const [selection] = useState(createSelectionReferences)
  const selectionKey = useMemo(() => selection.key(doc), [selection, doc, version])
  useEffect(() => {
    if (loading) return
    selection.follow(doc, setDraft, editor, session.key)
    // 只在选区（含批注）变化时同步；画布内容变化不该触发（那会把手动移除的又加回来）。
  }, [selection, selectionKey, loading, session])

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

  // 做不了视频的部署里「视频」这个选项不该出现，存下来的旧草稿也按图片算——
  // 服务端在那种部署里本来就会把视频轮当图片轮装配，开关留着只会骗人。
  const videoAvailable = isVideoModeAvailable()
  const mode = videoAvailable ? draftMode(draft) : 'image'
  // 草稿负责持久化，store 负责让「代用户发一轮」的入口（澄清作答等）也拿得到同一个值。
  // 换会话时这份草稿重新读盘，读完再同步过去，所以切走不会把上一个会话的类型带过去。
  const setSessionMode = useAgentStore((state) => state.setMode)
  useEffect(() => {
    if (!loading) setSessionMode(mode)
  }, [mode, loading, setSessionMode])

  const skills = useAgentSkills(mode)

  // 两个弹层共用可见文本这一套坐标：光标是按可见文本算的，拿存储形态去切会各说各的。
  const visible = getVisiblePrompt(draft.prompt, labels)
  const query = isCursorInSelectedImageMention(draft.prompt, cursor, labels)
    ? null
    : getAtImageQuery(visible, cursor)
  // `/` 只在整段话的开头算命令，所以它和 `@` 不会同时有候选。
  const skillQuery =
    query || editorRef.current?.querySelector('[data-skill-command]')
      ? null
      : getSlashSkillQuery(visible, cursor)
  const groups: SuggestionMenuGroup<ComposerSuggestion>[] = query
    ? buildAgentMentionGroups({ query: query.query, references: draft.references, canvas, assets })
    : skillQuery
      ? buildAgentSkillGroups(skillQuery.query, skills, (skill) => ({
          type: 'skill',
          name: skill.name,
        }))
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

  const selectSkill = (name: string) => {
    const el = editorRef.current
    const at = el ? getContentEditableCursor(el) : cursor
    const next = applySkillCommand(draft.prompt, getVisiblePrompt(draft.prompt, labels), at, name)
    typedRef.current = null
    setDraft((current) => ({ ...current, prompt: next.prompt }))
    setCursor(next.cursor)
    window.setTimeout(() => {
      const editor = editorRef.current
      if (!editor) return
      editor.focus()
      setContentEditableCursor(editor, next.cursor)
    }, 0)
  }

  const selectMention = async (value: AgentMentionValue) => {
    const el = editorRef.current
    const at = el ? getContentEditableCursor(el) : cursor
    const active = getAtImageQuery(getVisiblePrompt(draft.prompt, labels), at)
    if (!active) return

    // 只有素材要等图取回来；另外两支就在手边，别让它们也隔一个微任务才插胶囊。
    const reference =
      value.type === 'asset'
        ? await assetToReference(value.id)
        : value.type === 'reference'
          ? draft.references[value.index]
          : canvasReference(canvas, value.imageId)
    if (reference) applyAttach(reference, active.start, at)
  }

  const menu = useSuggestionMenu({
    groups,
    onSelect: (value: ComposerSuggestion) => {
      if (value.type === 'skill') selectSkill(value.name)
      else void selectMention(value)
    },
    onClose: () => editorRef.current?.blur(),
  })

  /**
   * 遮罩编辑器是工作台那台，这里只借会话：图直接交过去（画布对象的 id 进不了图片存储），
   * 画完的遮罩回到这份草稿里，工作台自己的遮罩草稿一概不动。
   */
  const editMask = (reference: AgentReference) => {
    const open = (target: string) =>
      useStore.getState().openMaskEditorSession(reference.id, {
        maskDataUrl: reference.maskDataUrl ?? null,
        keepSemantics: false,
        targetDataUrl: target,
        onSave: ({ maskDataUrl, targetDataUrl }) => {
          setDraft((current) =>
            setReferenceMask(current, reference.id, { maskDataUrl, dataUrl: targetDataUrl }),
          )
        },
        onRemove: () => {
          setDraft((current) => clearReferenceMask(current, reference.id))
        },
      })
    if (mediaIdentity(reference.dataUrl))
      void resolveMediaSource(reference.dataUrl).then(open, () =>
        useStore.getState().showToast(t('composer.sendFailedToast'), 'error'),
      )
    else open(reference.dataUrl)
  }

  const submit = () => {
    if (loading || submitting || historyBlocked || stopping) return
    const submission = draftForSubmit(draft)
    if (!submission.text.trim()) return
    // 乐观发送：敲下回车输入框立刻清空，那句话已经在对话里了；服务端没收下再把草稿放回来。
    const snapshot = draft
    session.accept(snapshot)
    selection.sent()
    setCursor(0)
    const releaseSubmission = session.beginSubmission()
    let accepted = false
    const restore = (cancelled = false) => {
      useStore
        .getState()
        .showToast(
          cancelled ? t('composer.abortedToast') : t('composer.sendFailedToast'),
          cancelled ? 'info' : 'error',
        )
      // 这几秒里用户要是已经开始打下一句，别把它冲掉。
      setDraft((current) =>
        current.prompt.trim() || current.references.length ? current : snapshot,
      )
    }
    void useAgentStore
      .getState()
      .send(
        submission.text,
        submission.references,
        () => {
          accepted = true
          releaseSubmission()
        },
        mode,
      )
      .then(
        (outcome) => {
          if (!accepted) restore(outcome === 'cancelled')
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
          {t('composer.dropHint')}
        </div>
      )}
      {draftError && (
        <p role="alert" className="text-xs text-warning">
          {draftError}
        </p>
      )}
      {unsent && !hasDraftContent(draft) && (
        <div role="status" className={`flex items-center gap-2 px-1 ${CARD_NOTE}`}>
          <span className="min-w-0 flex-1">{t('draft.unsent')}</span>
          <button type="button" className={GHOST_LINK} onClick={session.restoreUnsent}>
            {t('draft.restore')}
          </button>
          <button
            type="button"
            className={`${CARD_NOTE} transition-colors hover:text-foreground`}
            onClick={session.discardUnsent}
          >
            {t('draft.discard')}
          </button>
        </div>
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
                    <MediaImage
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
                    aria-label={
                      masked
                        ? t('composer.editMaskAria', { label })
                        : t('composer.drawMaskAria', { label })
                    }
                    className={`shrink-0 ${ICON_BUTTON}`}
                    onClick={() => editMask(reference)}
                  >
                    <MaskBrushIcon className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    aria-label={t('composer.removeReferenceAria', { label })}
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
            aria-label={t('composer.editorAria')}
            contentEditable={!loading}
            aria-busy={loading}
            suppressContentEditableWarning
            data-placeholder={t('composer.placeholder')}
            className={EDITOR_CLASS}
            onInput={(event) => {
              const el = event.currentTarget
              // Image-only tokens have no DOM text, but still contain a canonical prompt.
              if (!getContentEditablePlainText(el) && el.innerHTML) el.innerHTML = ''
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
            onCopy={copySelection}
            onCut={(event) => {
              if (copySelection(event)) document.execCommand('delete')
            }}
            onCompositionStart={() => {
              composingRef.current = true
            }}
            onCompositionEnd={() => {
              composingRef.current = false
            }}
          />
          <AgentEditorMentions
            key={pasteVersion}
            editorRef={editorRef}
            typedRef={typedRef}
            composingRef={composingRef}
            prompt={draft.prompt}
            labels={labels}
            references={draft.references}
            skills={skills}
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
              aria-label={t('composer.fileInputAria')}
              onChange={(event) => {
                attachFiles([...(event.currentTarget.files ?? [])])
                event.currentTarget.value = ''
              }}
            />
            <ComposerAttachButton
              aria-label={t('composer.attachAria')}
              title={t('composer.attachTitle')}
              disabled={loading}
              onClick={() => fileInputRef.current?.click()}
            />
          </div>
          <ComposerActions className="min-w-0">
            {videoAvailable && (
              <Select
                value={mode}
                onValueChange={(value) =>
                  setDraft((current) => ({
                    ...current,
                    mode: value === 'video' ? 'video' : 'image',
                  }))
                }
              >
                <SelectTrigger
                  aria-label={`${t('composer.modeAria')}：${t(mode === 'video' ? 'composer.modeVideo' : 'composer.modeImage')}`}
                  title={t(mode === 'video' ? 'composer.modeVideo' : 'composer.modeImage')}
                  className="h-8 w-8 justify-center rounded-full border-0 bg-muted p-0 text-muted-foreground [&>svg]:hidden"
                >
                  <SelectValue>
                    {mode === 'video' ? (
                      <VideoIcon className="h-4 w-4" aria-hidden="true" />
                    ) : (
                      <ImageIcon className="h-4 w-4" aria-hidden="true" />
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="image">
                    <span className="flex items-center gap-2">
                      <ImageIcon className="h-4 w-4" aria-hidden="true" />
                      {t('composer.modeImage')}
                    </span>
                  </SelectItem>
                  <SelectItem value="video">
                    <span className="flex items-center gap-2">
                      <VideoIcon className="h-4 w-4" aria-hidden="true" />
                      {t('composer.modeVideo')}
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
            )}
            <AgentParamsChip />
            {running && (
              <button
                type="button"
                className={ABORT_BUTTON}
                disabled={stopping}
                onClick={() => void useAgentStore.getState().abort()}
              >
                {stopping ? t('composer.aborting') : t('composer.abort')}
              </button>
            )}
            <ComposerSend
              streaming={false}
              idle={
                !stopping &&
                !historyBlocked &&
                !loading &&
                !submitting &&
                Boolean(draft.prompt.trim())
              }
              aria-label={
                submitting
                  ? t('composer.sending')
                  : running
                    ? t('composer.interject')
                    : t('composer.sendAndCreate')
              }
              title={running ? t('composer.interject') : t('composer.sendAndCreate')}
              disabled={historyBlocked || loading || submitting || !draft.prompt.trim()}
              onClick={submit}
            />
          </ComposerActions>
        </ComposerToolbar>
      </ComposerBar>
    </Composer>
  )
}
