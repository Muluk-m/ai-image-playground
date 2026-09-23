import { AGENT_TURN_MAX_REFERENCES } from '@image-playground/shared'
import { Zap } from 'lucide-react'
import {
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
import LookChips from '../../../components/LookChips'
import MediaImage from '../../../components/MediaImage'
import PromptEditor, { usePromptEditor } from '../../../components/PromptEditor'
import SuggestionMenu, {
  type SuggestionMenuGroup,
  useSuggestionMenu,
} from '../../../components/SuggestionMenu'
import { Button } from '../../../components/ui/button'
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
import { API_MAX_IMAGES, MAX_IMAGE_MB } from '../../../lib/inputImageLimit'
import { getAtImageQuery, getImageMentionLabel } from '../../../lib/promptImageMentions'
import { useStore } from '../../../store'
import type { CanvasDoc } from '../../canvas/lib/canvasDoc'
import { useCanvasProjectStore } from '../../canvas/projectStore'
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
  getLeadingAgentSkill,
  getSlashSkillQuery,
} from '../lib/agentSkillMentions'
import {
  attachAssetToDraft,
  attachReferences,
  filesToReferences,
  setAgentComposerAttach,
} from '../lib/attachments'
import { setAgentComposerFill } from '../lib/composerFill'
import type { MarkRenderer } from '../lib/markedReferences'
import { currentProjectDraft } from '../lib/projectLifecycle'
import {
  type AgentReference,
  type AttachedReference,
  attachReference,
  clearReferenceMask,
  draftForSubmit,
  hasDraftContent,
  referenceDisplayNames,
  referenceLabels,
  removeReference,
  setReferenceMask,
} from '../lib/references'
import { createSelectionReferences } from '../lib/selectionReferences'
import { useAgentSkills } from '../lib/useAgentSkills'
import { useAgentStore } from '../store'
import AgentParamsChip from './AgentParamsChip'
import AgentSkillBadge from './AgentSkillBadge'

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
  const autoSubmit = useAgentStore((state) => state.autoSubmit)
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
  const fileInputRef = useRef<HTMLInputElement>(null)
  // 菜单要用编辑器报的查询，编辑器的按键又要先问菜单——这一环用 ref 断开。
  const menuRef = useRef<{
    open: () => void
    handleKeyDown: (event: KeyboardEvent<HTMLDivElement>) => boolean
  }>({ open: () => {}, handleKeyDown: () => false })

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
  const referenceNames = referenceDisplayNames(draft.references)
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
    setDraft((current) => ({ ...current, prompt: text }))
    promptEditor.focusAt(text.length)
  }
  useEffect(() => setAgentComposerFill(fillText))

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
  const tooManyReferences = () =>
    useStore
      .getState()
      .showToast(t('composer.tooManyReferences', { count: AGENT_TURN_MAX_REFERENCES }), 'error')
  useEffect(() => {
    if (loading) return
    if (selection.follow(doc, setDraft, editor, session.key) > 0) tooManyReferences()
    // 只在选区（含批注）变化时同步；画布内容变化不该触发（那会把手动移除的又加回来）。
  }, [selection, selectionKey, loading, session])

  // 做不了视频的部署里视频轮不该出现，存下来的旧草稿也按图片算——
  // 服务端在那种部署里本来就会把视频轮当图片轮装配，标识留着只会骗人。
  const videoAvailable = isVideoModeAvailable()
  // 创作类型跟着项目走：项目建出来是图片画布还是视频画布，这里就一直是哪一轮，中途换不了。
  const projectKind = useCanvasProjectStore((state) =>
    state.projects.find((one) => one.id === state.activeId)?.kind === 'video' ? 'video' : 'image',
  )
  const mode = videoAvailable ? projectKind : 'image'
  // 草稿负责持久化，store 负责让「代用户发一轮」的入口（澄清作答等）也拿得到同一个值。
  const setSessionMode = useAgentStore((state) => state.setMode)
  useEffect(() => {
    if (!loading) setSessionMode(mode)
  }, [mode, loading, setSessionMode])

  const skills = useAgentSkills(mode)
  // 开头的 `/技能` 提升成胶囊；名字还在打的时候不提升，否则菜单会被胶囊关在外面。
  const skillInvocation = useMemo(
    () => getLeadingAgentSkill(draft.prompt, skills),
    [draft.prompt, skills],
  )

  const promptEditor = usePromptEditor({
    value: draft.prompt,
    labels,
    referenceIds: draft.references.map((reference) => reference.id),
    onChange: (prompt) => setDraft((current) => ({ ...current, prompt })),
    command: skillInvocation?.rest ? skillInvocation.command : null,
    commandLabel: skillInvocation?.skill.title,
    commandChip: skillInvocation && <AgentSkillBadge skill={skillInvocation.skill} />,
    parseCommand: getSlashSkillQuery,
    renderMention: (imageIndex) => {
      const reference = draft.references[imageIndex]
      if (!reference) return null
      return (
        <>
          <MediaImage
            src={reference.dataUrl}
            alt=""
            draggable={false}
            className="h-6 w-6 shrink-0 rounded object-cover"
          />
          {referenceNames[imageIndex] && (
            <span className="max-w-36 truncate">{referenceNames[imageIndex]}</span>
          )}
        </>
      )
    },
    onEdit: () => menuRef.current.open(),
    onKeyDown: (event) => {
      if (menuRef.current.handleKeyDown(event)) return
      if (event.key !== 'Enter') return
      if (event.shiftKey) {
        promptEditor.insertText('\n')
        return
      }
      submit()
    },
    onPaste: (event) => {
      const files = [...event.clipboardData.files]
      if (files.length === 0) return
      event.preventDefault()
      attachFiles(files)
    },
  })

  const groups: SuggestionMenuGroup<ComposerSuggestion>[] =
    promptEditor.query?.kind === 'mention'
      ? buildAgentMentionGroups({
          query: promptEditor.query.query,
          references: draft.references,
          canvas,
          assets,
        })
      : promptEditor.query?.kind === 'command'
        ? buildAgentSkillGroups(promptEditor.query.query, skills, (skill) => ({
            type: 'skill',
            name: skill.name,
          }))
        : []

  const applyAttach = (next: AttachedReference) => {
    if (next.overflow) {
      tooManyReferences()
      return
    }
    setDraft(next.draft)
    promptEditor.focusAt(next.cursor)
  }

  const selectSkill = (name: string) => {
    const at = promptEditor.cursor()
    const next = applySkillCommand(draft.prompt, promptEditor.visible, at, name)
    setDraft((current) => ({ ...current, prompt: next.prompt }))
    promptEditor.focusAt(next.cursor)
  }

  const selectMention = async (value: AgentMentionValue) => {
    // 选中的这一刻重新问一次光标：菜单开着的时候用户还可能移动它。
    const at = promptEditor.cursor()
    const active = getAtImageQuery(promptEditor.visible, at)
    if (!active) return

    // 只有素材要等图取回来；另外两支就在手边，别让它们也隔一个微任务才插胶囊。
    if (value.type === 'asset') {
      const attached = await attachAssetToDraft(draft, value.id, active.start, at)
      if (attached) applyAttach(attached)
      return
    }
    const reference =
      value.type === 'reference'
        ? draft.references[value.index]
        : canvasReference(canvas, value.imageId)
    if (reference) applyAttach(attachReference(draft, reference, active.start, at))
  }

  const menu = useSuggestionMenu({
    groups,
    onSelect: (value: ComposerSuggestion) => {
      if (value.type === 'skill') selectSkill(value.name)
      else void selectMention(value)
    },
    onClose: promptEditor.blur,
  })
  menuRef.current = { open: menu.open, handleKeyDown: menu.handleKeyDown }

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
              const label = referenceNames[index] ?? getImageMentionLabel(index)
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
          <PromptEditor
            editor={promptEditor}
            role="textbox"
            tabIndex={0}
            aria-label={t('composer.editorAria')}
            disabled={loading}
            aria-busy={loading}
            placeholder={t('composer.placeholder')}
            className={EDITOR_CLASS}
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
              title={t('composer.attachTitle', { count: API_MAX_IMAGES, mb: MAX_IMAGE_MB })}
              disabled={loading}
              onClick={() => fileInputRef.current?.click()}
            />
          </div>
          <ComposerActions className="min-w-0">
            {/* 模式只是状态展示、点不动，挤在按钮排里反而像可点控件——交给参数 chip 说明。 */}
            <Button
              type="button"
              size="icon"
              variant={autoSubmit ? 'default' : 'secondary'}
              aria-pressed={autoSubmit}
              aria-label={t('composer.autoSubmitAria')}
              title={t(autoSubmit ? 'composer.autoSubmitOnTitle' : 'composer.autoSubmitOffTitle')}
              className="h-8 w-8 shrink-0 rounded-full"
              onClick={() => useAgentStore.getState().setAutoSubmit(!autoSubmit)}
            >
              <Zap aria-hidden="true" />
            </Button>
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
                    ? t('composer.queue')
                    : t('composer.sendAndCreate')
              }
              title={running ? t('composer.queue') : t('composer.sendAndCreateTitle')}
              disabled={historyBlocked || loading || submitting || !draft.prompt.trim()}
              onClick={submit}
            />
          </ComposerActions>
        </ComposerToolbar>
      </ComposerBar>
      {mode === 'image' && <LookChips onPick={(look) => selectSkill(look.skillName)} />}
    </Composer>
  )
}
