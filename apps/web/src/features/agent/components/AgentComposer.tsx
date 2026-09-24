import { AGENT_TURN_ATTACHED_MEDIA_MAX } from '@image-playground/shared'
import { FolderOpen, Images, Zap } from 'lucide-react'
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
import ContextMenu, { ContextMenuItem } from '../../../components/ContextMenu'
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
import { confirmImageBatch } from '../../../lib/confirmImageBatch'
import { acceptImageFiles, filesFromFolderInput } from '../../../lib/imageFiles'
import { API_MAX_IMAGES, MAX_IMAGE_MB } from '../../../lib/inputImageLimit'
import { getAtImageQuery, getImageMentionLabel } from '../../../lib/promptImageMentions'
import { useStore } from '../../../store'
import type { CanvasDoc } from '../../canvas/lib/canvasDoc'
import { cloudProjectsEnabled } from '../../canvas/lib/projectClient'
import { useCanvasProjectStore } from '../../canvas/projectStore'
import { useLibraryStore } from '../../library/store'
import { CARD_NOTE, GHOST_LINK, ICON_BUTTON } from '../agentStyles'
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
  referenceLimitMessage,
  setAgentComposerAttach,
} from '../lib/attachments'
import { setAgentComposerFill } from '../lib/composerFill'
import type { MarkRenderer } from '../lib/markedReferences'
import { currentProjectDraft } from '../lib/projectLifecycle'
import { agentPromptHistory, rememberAgentPrompt } from '../lib/promptHistory'
import {
  type AgentReference,
  type AttachedReference,
  attachReference,
  clearReferenceMask,
  draftForSubmit,
  hasDraftContent,
  type ReferenceTransport,
  referenceDisplayNames,
  referenceLabels,
  removeReference,
  removeSelectionReferences,
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

/** 附件菜单贴在回形针上方：两条目加内边距的实测高度，越界的那点由 ContextMenu 夹回视口。 */
const ATTACH_MENU_HEIGHT = 96

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
  const folderInputRef = useRef<HTMLInputElement>(null)
  // 回形针点开的「图片 / 文件夹」两选一，位置按按钮实测。
  const [attachMenu, setAttachMenu] = useState<{ x: number; y: number } | null>(null)
  // 菜单要用编辑器报的查询，编辑器的按键又要先问菜单——这一环用 ref 断开。
  const menuRef = useRef<{
    open: () => void
    handleKeyDown: (event: KeyboardEvent<HTMLDivElement>) => boolean
  }>({ open: () => {}, handleKeyDown: () => false })

  // 拖进来、粘贴进来、点回形针选进来的图片都走这一条：读文件 → 压缩 → 进引用区。
  // 一次进来的图多了先问一声：整份文件夹误拖进来时，确认框比事后逐张删引用便宜。
  const attachFiles = (files: File[]) => {
    if (loading) {
      useStore.getState().showToast(t('composer.draftLoadingToast'), 'info')
      return
    }
    const images = acceptImageFiles(files)
    if (images.length === 0) return
    confirmImageBatch(images.length, () => {
      void filesToReferences(images).then((added) => {
        setDraft((current) => attachReferences(current, added, transportRef.current))
      })
    })
  }
  // 圈得多时一张张胶囊铺满输入框没有意义：模型这时也只拿清单（见 AGENT_TURN_ATTACHED_MEDIA_MAX），
  // 收成一条「已选 N 张画布图」。手动附上的照旧逐张显示。
  const selected = draft.references.filter((one) => one.origin === 'selection')
  const selectionSummary = selected.length > AGENT_TURN_ATTACHED_MEDIA_MAX ? selected : []
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
  // 哪些参考图发送时能按 id 走（见 `sendsById`）：决定放得下多少。选区同步的 effect 只在选区
  // 变化时跑，所以经 ref 取最新一份，别把画布内容列进它的依赖。
  const cloudProject =
    useCanvasProjectStore((state) =>
      Boolean(state.projects.find((one) => one.id === state.activeId)?.cloud),
    ) && cloudProjectsEnabled()
  const transport = useMemo<ReferenceTransport>(
    () => ({ cloud: cloudProject, canvasSources: new Set(Object.values(doc.files)) }),
    [cloudProject, doc, version],
  )
  const transportRef = useRef(transport)
  transportRef.current = transport
  useEffect(() => {
    if (loading) return
    // 撞的是哪道上限由准入定夺，文案跟着它走——输入框不再自己数一遍两道上限。
    const overflow = selection.follow(doc, setDraft, editor, session.key, transportRef.current)
    if (overflow.refusal)
      useStore
        .getState()
        .showToast(referenceLimitMessage(overflow.refusal, transportRef.current), 'error')
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
      if (recallKeyDown(event)) return
      // 写着字时按钮是发送，中止没有可点的入口；Esc 补上它，不必先清空输入框。
      if (event.key === 'Escape' && running && !stopping) {
        event.preventDefault()
        void useAgentStore.getState().abort()
        return
      }
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
    if (next.refusal) {
      useStore
        .getState()
        .showToast(referenceLimitMessage(next.refusal, transportRef.current), 'error')
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
      const attached = await attachAssetToDraft(
        draft,
        value.id,
        active.start,
        at,
        transportRef.current,
      )
      if (attached) applyAttach(attached)
      return
    }
    const reference =
      value.type === 'reference'
        ? draft.references[value.index]
        : canvasReference(canvas, value.imageId)
    if (reference)
      applyAttach(attachReference(draft, reference, active.start, at, transportRef.current))
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

  /**
   * 发送与中止是同一颗按钮的两个状态：输入框空着才是中止，写了字就是发送（忙时进排队）。
   * 停止只掐当前这段回复，已经在跑的出图不受影响（ADR 0012）。
   *
   * 点下去这颗按钮当场变回发送，不再有「正在中止…」的禁用态：跟服务端交涉的那几百毫秒里
   * 用户照常打字、照常发，`send` 会静默等中止落定再起新轮。
   */
  const stopMode = running && !stopping && !draft.prompt.trim()

  const submit = () => {
    if (loading || submitting || historyBlocked) return
    const submission = draftForSubmit(draft)
    if (!submission.text.trim()) return
    // 乐观发送：敲下回车输入框立刻清空，那句话已经在对话里了；服务端没收下再把草稿放回来。
    const snapshot = draft
    session.accept(snapshot)
    selection.sent()
    browsingRef.current = null
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
          rememberAgentPrompt(snapshot.prompt)
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

  /**
   * shell 式的上下翻：`index` 是从用户自己打的那份往回数的步数，0 就是那份本身。
   * 一路带着 `typed`，翻过头再往前走要把它原样放回去。一开始翻就把历史定住：
   * 翻的过程中这个会话又发出去一句（排队的那种），脚下的清单不该跟着变。
   * `shown` 是上一下翻进输入框的那句：提示词不再是它，就说明用户自己动过，这一串不算数了。
   */
  const browsingRef = useRef<{
    entries: readonly string[]
    index: number
    typed: string
    shown: string
  } | null>(null)

  const recall = (step: 1 | -1): boolean => {
    const browsing =
      browsingRef.current?.shown === draft.prompt
        ? browsingRef.current
        : { entries: agentPromptHistory(), index: 0, typed: draft.prompt, shown: draft.prompt }
    const index = browsing.index + step
    // 翻到最旧的那条就停住，别绕回最新的：绕回去看着像刚才那几下没生效。
    if (index < 0 || index > browsing.entries.length) return false
    const prompt = index === 0 ? browsing.typed : browsing.entries[browsing.entries.length - index]
    browsingRef.current = { ...browsing, index, shown: prompt }
    // 整句换掉，光标落到句末：胶囊与技能徽标由编辑器按这句重画，这里不碰 DOM。
    promptEditor.replaceRange(0, promptEditor.visible.length, prompt)
    return true
  }

  /** 候选菜单没开着时上下键翻历史：光标在首行往回翻、在末行往前翻，中间几行照常移动光标。 */
  const recallKeyDown = (event: KeyboardEvent<HTMLDivElement>): boolean => {
    const back = event.key === 'ArrowUp'
    if (!back && event.key !== 'ArrowDown') return false
    if (
      loading ||
      event.nativeEvent.isComposing ||
      event.shiftKey ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    )
      return false
    const range = promptEditor.selection()
    if (range.start !== range.end) return false
    const visible = promptEditor.visible
    const edge = back
      ? range.start === 0 || visible.lastIndexOf('\n', range.start - 1) === -1
      : visible.indexOf('\n', range.start) === -1
    if (!edge || !recall(back ? 1 : -1)) return false
    event.preventDefault()
    return true
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
            {selectionSummary.length > 0 && (
              <div className="flex max-w-full items-center gap-2 rounded-lg border border-border bg-muted/60 p-1 pr-1.5">
                <div className="flex -space-x-3">
                  {selectionSummary.slice(0, AGENT_TURN_ATTACHED_MEDIA_MAX).map((one) => (
                    <MediaImage
                      key={one.id}
                      src={one.dataUrl}
                      className={`${STRIP_THUMB} ring-2 ring-muted`}
                      alt=""
                    />
                  ))}
                </div>
                <span className="whitespace-nowrap text-xs text-foreground">
                  {t('composer.selectionSummary', { count: selectionSummary.length })}
                </span>
                <button
                  type="button"
                  aria-label={t('composer.clearSelectionAria')}
                  className={`shrink-0 ${ICON_BUTTON}`}
                  onClick={() => setDraft(removeSelectionReferences(draft))}
                >
                  <CloseIcon className="h-3 w-3" />
                </button>
              </div>
            )}
            {draft.references.map((reference, index) => {
              if (selectionSummary.length > 0 && reference.origin === 'selection') return null
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
            <input
              ref={folderInputRef}
              type="file"
              // 文件夹选择器没有 React 的 prop 名，只能按 DOM 属性名直接摊上去。
              {...{ webkitdirectory: '' }}
              multiple
              className="hidden"
              aria-label={t('composer.folderInputAria')}
              onChange={(event) => {
                const { files } = filesFromFolderInput(event.currentTarget.files)
                event.currentTarget.value = ''
                attachFiles(files)
              }}
            />
            <ComposerAttachButton
              aria-label={t('composer.attachAria')}
              title={t('composer.attachTitle', { count: API_MAX_IMAGES, mb: MAX_IMAGE_MB })}
              aria-haspopup="menu"
              aria-expanded={attachMenu !== null}
              disabled={loading}
              onClick={(event) => {
                const bounds = event.currentTarget.getBoundingClientRect()
                setAttachMenu({ x: bounds.left, y: bounds.top - ATTACH_MENU_HEIGHT })
              }}
            />
            {attachMenu && (
              <ContextMenu x={attachMenu.x} y={attachMenu.y} onClose={() => setAttachMenu(null)}>
                <ContextMenuItem
                  icon={<Images className="h-4 w-4" aria-hidden="true" />}
                  label={t('composer.attachImages')}
                  onClick={() => {
                    setAttachMenu(null)
                    fileInputRef.current?.click()
                  }}
                />
                <ContextMenuItem
                  icon={<FolderOpen className="h-4 w-4" aria-hidden="true" />}
                  label={t('composer.attachFolder')}
                  onClick={() => {
                    setAttachMenu(null)
                    folderInputRef.current?.click()
                  }}
                />
              </ContextMenu>
            )}
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
            <ComposerSend
              streaming={stopMode}
              idle={!historyBlocked && !loading && !submitting && Boolean(draft.prompt.trim())}
              aria-label={
                stopMode
                  ? t('composer.abort')
                  : submitting
                    ? t('composer.sending')
                    : running
                      ? t('composer.queue')
                      : t('composer.sendAndCreate')
              }
              title={
                stopMode
                  ? t('composer.abortTitle')
                  : running
                    ? t('composer.queue')
                    : t('composer.sendAndCreateTitle')
              }
              disabled={
                stopMode ? false : historyBlocked || loading || submitting || !draft.prompt.trim()
              }
              onClick={stopMode ? () => void useAgentStore.getState().abort() : submit}
            />
          </ComposerActions>
        </ComposerToolbar>
      </ComposerBar>
      {mode === 'image' && <LookChips onPick={(look) => selectSkill(look.skillName)} />}
    </Composer>
  )
}
