import { AGENT_TURN_ATTACHED_MEDIA_MAX } from '@image-playground/shared'
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  AttachmentLoading,
  AttachmentTile,
} from '../../../components/assistant-ui/elements/attachment'
import { Composer, ComposerAttachments } from '../../../components/assistant-ui/elements/composer'
import {
  CreationBody,
  CreationFrame,
  CreationModePicker,
  CreationSend,
  CreationToolbar,
} from '../../../components/creation/CreationFrame'
import { CreationReferencePreview } from '../../../components/creation/CreationReferencePreview'
import { CreationReferenceStack } from '../../../components/creation/CreationReferenceStack'
import MediaImage from '../../../components/MediaImage'
import PromptEditor, { usePromptEditor } from '../../../components/PromptEditor'
import ContextMenu, { ContextMenuItem } from '../../../components/patterns/ContextMenu'
import SuggestionMenu, {
  type SuggestionMenuGroup,
  useSuggestionMenu,
} from '../../../components/SuggestionMenu'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select'
import { useImageDropZone } from '../../../hooks/useImageDropZone'
import { useTranslation } from '../../../i18n'
import {
  assetSlotAt,
  assetSlotImages,
  clearAssetSlot,
  fillAssetSlot,
} from '../../../lib/assetSlotDraft'
import { accountScope } from '../../../lib/authScope'
import { isVideoModeAvailable } from '../../../lib/channels/videoChannels'
import { getAttachmentLimits } from '../../../lib/clientCapabilities'
import {
  blobDataUrl,
  invalidateMediaPreview,
  mediaIdentity,
  resolveMediaSource,
} from '../../../lib/cloudMedia'
import { confirmImageBatch } from '../../../lib/confirmImageBatch'
import { acceptImageFiles, filesFromFolderInput } from '../../../lib/imageFiles'
import { API_MAX_IMAGES, MAX_IMAGE_MB } from '../../../lib/inputImageLimit'
import {
  attachmentSourceOwner,
  hasLocalAttachmentSources,
  localAttachmentFailure,
  localAttachmentIdentity,
  readAttachmentUpload,
  readLocalAttachment,
} from '../../../lib/localAttachmentSources'
import { getAtImageQuery, getImageMentionLabel } from '../../../lib/promptImageMentions'
import { bffBaseUrl } from '../../../lib/runtimeConfig'
import { useStore } from '../../../store'
import CanvasVideoParams from '../../canvas/components/CanvasVideoParams'
import { peekCanvasWorkspace } from '../../canvas/lib/activeProject'
import type { CanvasDoc } from '../../canvas/lib/canvasDoc'
import { cloudProjectsEnabled } from '../../canvas/lib/projectClient'
import { useCanvasProjectStore } from '../../canvas/projectStore'
import { useLibraryStore } from '../../library/store'
import ProductionQuoteChip from '../../production/components/ProductionQuoteChip'
import { useProductionSelection } from '../../production/lib/productionContext'
import { GHOST_LINK, ICON_BUTTON, INK, INK_3 } from '../agentStyles'
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
import { previewArtifactBitmap } from '../lib/artifactSource'
import {
  attachAssetToDraft,
  attachReferences,
  filesToReferences,
  referenceLimitMessage,
  setAgentComposerAttach,
} from '../lib/attachments'
import {
  attachmentUploadErrorMessage,
  canRetryAttachmentUpload,
} from '../lib/attachmentUploadErrors'
import {
  attachmentUploadError,
  attachmentUploadRevision,
  attachmentUploadState,
  attachmentUploadsEnabled,
  primeAttachmentUploads,
  retryAttachmentUploads,
  subscribeAttachmentUploads,
  withKnownAttachmentMedia,
} from '../lib/attachmentUploads'
import { agentComposerFillPrompt, useComposerFillTarget } from '../lib/composerFill'
import { conversationImages } from '../lib/conversationImages'
import { followUpGhostAction, visibleFollowUps } from '../lib/followUps'
import type { MarkRenderer } from '../lib/markedReferences'
import { currentProjectDraft } from '../lib/projectLifecycle'
import { agentPromptHistory, rememberAgentPrompt } from '../lib/promptHistory'
import {
  type AgentDraft,
  type AgentReference,
  type AttachedReference,
  agentAdmission,
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
import AgentParamsChip, { AgentExecutionSettings } from './AgentParamsChip'
import AgentSkillBadge from './AgentSkillBadge'
import { useAssetSlots } from './useAssetSlots'

const STRIP_THUMB = 'h-8 w-8 shrink-0 overflow-hidden rounded-md object-cover'

/**
 * 缩略图显示与上传分开：已有位图一加载就显示，发送仍等上传确认。
 */
function ComposerAttachmentThumb({
  src,
  className,
  frameClassName = '',
  alt = '',
  uploading = false,
  failed = false,
  retryPreview = false,
}: {
  src: string
  className: string
  frameClassName?: string
  alt?: string
  uploading?: boolean
  failed?: boolean
  retryPreview?: boolean
}) {
  const { t } = useTranslation('agent')
  const [revision, setRevision] = useState(0)
  const [retrying, setRetrying] = useState(false)
  const latestSource = useRef(src)
  latestSource.current = src
  const deferred = Boolean(
    mediaIdentity(src) || localAttachmentIdentity(src) || localAttachmentFailure(src),
  )
  const [settled, setSettled] = useState<{ src: string; ok: boolean }>()
  const here = settled?.src === src ? settled : undefined
  const pending = retrying || ((deferred || revision > 0) && !failed && here === undefined)
  const hide = pending || failed || here?.ok === false
  const previewFailed = !retrying && !uploading && !failed && here?.ok === false
  const onResolveError = useCallback(() => setSettled({ src, ok: false }), [src])
  const reloadPreview = async () => {
    const accountCurrent = accountScope()
    const backend = bffBaseUrl()
    const current = () =>
      accountCurrent() && backend === bffBaseUrl() && latestSource.current === src
    setRetrying(true)
    try {
      const upload = localAttachmentIdentity(src) ? await readAttachmentUpload(src, backend) : null
      if (!current()) return
      await invalidateMediaPreview(
        upload?.state === 'ready' ? `aip-media:${upload.result.id}` : src,
      )
      if (!current()) return
      setSettled(undefined)
      setRevision((one) => one + 1)
    } catch {
      // Keep the explicit failed preview and its retry action if cache invalidation failed.
    } finally {
      setRetrying(false)
    }
  }
  return (
    <span className={`relative inline-flex shrink-0 ${frameClassName}`}>
      <MediaImage
        key={revision}
        src={src}
        alt={alt}
        draggable={false}
        onLoad={(event) => {
          if (!event.currentTarget.getAttribute('src')) return
          setSettled({ src, ok: true })
        }}
        onError={(event) => {
          if (!event.currentTarget.getAttribute('src')) return
          setSettled({ src, ok: false })
        }}
        onResolveError={onResolveError}
        className={[className, hide ? 'opacity-0' : ''].filter(Boolean).join(' ')}
      />
      {(pending || uploading) && (
        <AttachmentLoading
          uploading={uploading}
          label={uploading ? t('composer.upload.uploading') : undefined}
        />
      )}
      {previewFailed &&
        (retryPreview ? (
          <>
            <span
              role="img"
              aria-label={t('tool.previewUnavailable')}
              className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 rounded-md bg-background/90 pb-8 text-destructive"
            >
              <Icon name="error" />
              <span className="text-label-sm">{t('tool.previewUnavailable')}</span>
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              title={t('tool.retryPreview')}
              aria-label={`${t('tool.previewUnavailable')}：${t('tool.retryPreview')} ${alt}`}
              className="absolute bottom-0 right-0 z-10 h-11 w-11 text-destructive"
              onClick={() => void reloadPreview()}
            >
              <Icon name="refresh" />
            </Button>
          </>
        ) : (
          <span
            role="img"
            aria-label={t('tool.previewUnavailable')}
            title={t('tool.previewUnavailable')}
            className="pointer-events-none absolute inset-0 grid place-items-center text-destructive"
          >
            <Icon name="error" />
          </span>
        ))}
    </span>
  )
}

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
  showCanvasReferences = true,
  productionMode = false,
}: {
  welcome?: boolean
  showLooks?: boolean
  showCanvasReferences?: boolean
  productionMode?: boolean
  doc: CanvasDoc
  /** 把选中的批注烧进参考图要它来栅格化；没有就只带原图。 */
  editor?: MarkRenderer
}) {
  const { t, i18n } = useTranslation(['agent', 'errors', 'composer'])
  const historyBlocked = useAgentStore((state) => state.historyLoading || state.historyFailed)
  const running = useAgentStore((state) => state.turn === 'running')
  const stopping = useAgentStore((state) => state.stopping)
  const messages = useAgentStore(
    useShallow((state) =>
      state.messages.filter(
        (message) => message.kind === 'tool' && Boolean(message.artifacts?.length),
      ),
    ),
  )
  const assets = useLibraryStore((state) => state.assets)
  const loadAssets = useLibraryStore((state) => state.loadAssets)
  const conversationId = useAgentStore((state) => state.conversationId)
  const selectedProduction = useProductionSelection(conversationId)
  const previousProduction = useRef({ conversationId, selection: selectedProduction })
  const session = currentProjectDraft(conversationId)
  const {
    draft,
    loading: readingDraft,
    recoveryBlocked,
    submitting,
    error: draftError,
    unsent,
    recoverable,
  } = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const loading = readingDraft || recoveryBlocked
  const followUpLines = useAgentStore((state) =>
    visibleFollowUps({
      idle: state.turn === 'idle',
      historyBlocked: state.historyLoading || state.historyFailed,
      welcome,
      draft: draft.prompt,
      messages: state.messages,
      turns: state.turns,
    }),
  )
  const followUpHintId = useId()
  const [dismissedFollowUp, setDismissedFollowUp] = useState<string | null>(null)
  useEffect(() => {
    setDismissedFollowUp(null)
  }, [conversationId])
  const followUpGhost =
    followUpLines[0] && followUpLines[0] !== dismissedFollowUp ? followUpLines[0] : null
  const acceptFollowUpRef = useRef<(line: string) => void>(() => {})
  const setDraft = session.update
  useSyncExternalStore(subscribeAttachmentUploads, attachmentUploadRevision)
  const version = useSyncExternalStore(doc.subscribe, () => doc.version)
  const workspace = peekCanvasWorkspace()
  const cloud = workspace?.doc === doc ? workspace.cloud : undefined
  const cloudState = useSyncExternalStore(
    cloud?.subscribe ?? (() => () => {}),
    cloud?.getSnapshot ?? (() => undefined),
  )
  const knownMedia = useMemo(
    () =>
      new Map(
        Object.entries(doc.files).flatMap(([fileId, source]) => {
          const id = cloud?.knownMediaId(fileId, source)
          return id ? [[source, id] as const] : []
        }),
      ),
    [doc, version, cloud, cloudState],
  )
  const uploadReference = (reference: AgentReference) =>
    withKnownAttachmentMedia(reference, (source) => knownMedia.get(source))
  const uploadReferences = useMemo(
    () =>
      draft.references.map((reference) =>
        withKnownAttachmentMedia(reference, (source) => knownMedia.get(source)),
      ),
    [draft.references, knownMedia],
  )
  useEffect(() => primeAttachmentUploads(uploadReferences), [uploadReferences])
  const uploadsBlocked = draft.references.some((reference) => {
    const state = attachmentUploadState(uploadReference(reference))
    return state !== undefined && state !== 'ready'
  })
  const failedReference = draft.references.find(
    (reference) => attachmentUploadState(uploadReference(reference)) === 'failed',
  )
  const uploadingCount = draft.references.filter((reference) =>
    ['queued', 'uploading', 'verifying'].includes(
      attachmentUploadState(uploadReference(reference)) ?? '',
    ),
  ).length
  const referenceStatus = failedReference
    ? attachmentUploadErrorMessage(
        attachmentUploadError(uploadReference(failedReference)),
        getAttachmentLimits(),
      )
    : uploadingCount > 0
      ? t('composer:studio.uploadProgress', {
          ready: draft.references.length - uploadingCount,
          total: draft.references.length,
        })
      : undefined

  const retryUpload = (reference: AgentReference) => {
    void retryAttachmentUploads(uploadReference(reference)).catch(() => {})
  }
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

  // 拖进来、粘贴进来、点回形针选进来的图片都走这一条：整组读取 → 进引用区。
  // 一次进来的图多了先问一声：整份文件夹误拖进来时，确认框比事后逐张删引用便宜。
  const attachmentRevision = useRef(0)
  const attachFiles = (files: File[]) => {
    const revision = attachmentRevision.current
    if (loading) {
      useStore.getState().showToast(t('composer.draftLoadingToast'), 'info')
      return
    }
    const images =
      attachmentUploadsEnabled() && getAttachmentLimits()
        ? files.filter((file) => file.type.startsWith('image/'))
        : acceptImageFiles(files)
    if (images.length === 0) return
    const limits = attachmentUploadsEnabled() ? getAttachmentLimits() : undefined
    if (
      limits &&
      session.getSnapshot().draft.references.length + images.length > limits.logicalReferences
    ) {
      useStore
        .getState()
        .showToast(t('composer.tooManyReferences', { count: limits.logicalReferences }), 'error')
      return
    }
    const currentAccount = accountScope()
    confirmImageBatch(images.length, () => {
      if (!currentAccount() || revision !== attachmentRevision.current) return
      const currentLimits = attachmentUploadsEnabled() ? getAttachmentLimits() : undefined
      if (
        limits &&
        (!currentLimits ||
          session.getSnapshot().draft.references.length + images.length >
            currentLimits.logicalReferences)
      ) {
        useStore.getState().showToast(
          t('composer.tooManyReferences', {
            count: currentLimits?.logicalReferences ?? limits.logicalReferences,
          }),
          'error',
        )
        return
      }
      const added = filesToReferences(images)
      if (Array.isArray(added)) {
        setDraft((current) => attachReferences(current, added, transportRef.current))
      } else {
        void added
          .then((references) => {
            if (!currentAccount() || revision !== attachmentRevision.current) return
            setDraft((current) => attachReferences(current, references, transportRef.current))
          })
          .catch((error: unknown) =>
            useStore
              .getState()
              .showToast(
                attachmentUploadErrorMessage(
                  error instanceof Error ? error.message : undefined,
                  getAttachmentLimits(),
                ),
                'error',
              ),
          )
      }
    })
  }
  // 圈得多时一张张胶囊铺满输入框没有意义：模型这时也只拿清单（见 AGENT_TURN_ATTACHED_MEDIA_MAX），
  // 收成一条「已选 N 张画布图」。手动附上的照旧逐张显示。
  useEffect(() => {
    if (
      previousProduction.current.conversationId === conversationId &&
      previousProduction.current.selection !== selectedProduction
    ) {
      setDraft((current) => (current.submission ? { ...current, submission: undefined } : current))
    }
    previousProduction.current = { conversationId, selection: selectedProduction }
  }, [conversationId, selectedProduction, setDraft])

  const selected = draft.references.filter((one) => one.origin === 'selection')
  const selectionSummary = selected.length > AGENT_TURN_ATTACHED_MEDIA_MAX ? selected : []
  const referenceNames = referenceDisplayNames(draft.references)
  const { dragging, dropZoneProps } = useImageDropZone(attachFiles)
  // 面板把落在对话记录上的文件递过来。
  useEffect(() => {
    setAgentComposerAttach(attachFiles)
    return () => setAgentComposerAttach(null)
  })
  // 示例建议与起手句点进来的那一句：技能写成开头的 `/技能名`（随即提升成胶囊），示例词选中。
  useComposerFillTarget({
    read: () => session.getSnapshot().draft.prompt,
    busy: () => {
      if (loading) useStore.getState().showToast(t('composer.draftLoadingToast'), 'info')
      return loading
    },
    write: (content) => {
      const { prompt, selection } = agentComposerFillPrompt(content)
      if (content.clearReferences) {
        attachmentRevision.current += 1
        doc.setSelection([])
      }
      setDraft((current) => ({
        ...current,
        prompt,
        ...(content.clearReferences ? { references: [], submission: undefined } : {}),
      }))
      promptEditor.select(selection.start, selection.end)
      return prompt
    },
  })

  // 素材名要参与 `@` 候选与胶囊标签，不能等到用户打开素材库才读。
  useEffect(() => {
    void loadAssets()
  }, [loadAssets])

  // 序号胶囊的显示标签随界面语言变，下游按这份解析器缓存的渲染要跟着重算。
  const labels = useMemo(() => referenceLabels(draft.references), [draft.references, i18n.language])
  // `@` 候选里的「画布图 n」是界面文案，切语言要跟着换，所以语言也是这份缓存的入参。
  const canvas = useMemo(() => canvasImages(doc), [doc, version, i18n.language])

  const results = useMemo(
    () => conversationImages(messages, doc),
    [messages, doc, version, i18n.language],
  )

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
    if (loading || !showCanvasReferences) return
    // 撞的是哪道上限由准入定夺，文案跟着它走——输入框不再自己数一遍两道上限。
    const overflow = selection.follow(doc, setDraft, editor, session.key, transportRef.current)
    if (overflow.refusal)
      useStore
        .getState()
        .showToast(referenceLimitMessage(overflow.refusal, transportRef.current), 'error')
    // 只在选区（含批注）变化时同步；画布内容变化不该触发（那会把手动移除的又加回来）。
  }, [selection, selectionKey, loading, session, showCanvasReferences])

  // 做不了视频的部署里视频轮不该出现，存下来的旧草稿也按图片算——
  // 服务端在那种部署里本来就会把视频轮当图片轮装配，标识留着只会骗人。
  const videoAvailable = isVideoModeAvailable()
  const projectKind = useCanvasProjectStore((state) =>
    state.projects.find((one) => one.id === state.activeId)?.kind === 'video' ? 'video' : 'image',
  )
  const createTarget = useStore((state) => state.createTarget)
  const creationMode =
    createTarget === 'video' ? 'video' : createTarget === 'generate' ? 'image' : 'agent'
  useEffect(() => {
    const store = useStore.getState()
    const saved = store.projectCreationTargets[session.key]
    store.setCreateTarget(
      saved === 'video' && !videoAvailable
        ? 'chat'
        : (saved ?? (projectKind === 'video' && videoAvailable ? 'video' : 'chat')),
    )
  }, [session.key, projectKind, videoAvailable])
  const mode = productionMode || (videoAvailable && creationMode === 'video') ? 'video' : 'image'
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

  const renderSlot = useAssetSlots<AgentDraft>({
    read: () => session.getSnapshot().draft,
    write: setDraft,
    admission: () => agentAdmission(transportRef.current),
    refusalMessage: (reason) => referenceLimitMessage(reason, transportRef.current),
    fromAsset: (image, asset) => ({ ...image, name: asset.name }),
    fromFiles: filesToReferences,
    imageName: (reference) => reference.name,
    canvas: showCanvasReferences
      ? {
          images: () => canvas,
          reference: (image) => ({ id: image.imageId, dataUrl: image.dataUrl }),
        }
      : undefined,
    accepting: () => {
      const snapshot = session.getSnapshot()
      if (snapshot.loading || snapshot.recoveryBlocked) {
        useStore.getState().showToast(t('composer.draftLoadingToast'), 'info')
        return false
      }
      return useAgentStore.getState().conversationId === conversationId
    },
  })

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
      const mentionUpload = attachmentUploadState(uploadReference(reference))
      return (
        <>
          <ComposerAttachmentThumb
            src={reference.dataUrl}
            uploading={['queued', 'uploading', 'verifying'].includes(mentionUpload ?? '')}
            failed={mentionUpload === 'failed'}
            className="h-6 w-6 shrink-0 rounded object-cover"
          />
          {referenceNames[imageIndex] && (
            <span className="max-w-36 truncate">{referenceNames[imageIndex]}</span>
          )}
        </>
      )
    },
    renderSlot,
    onEdit: () => menuRef.current.open(),
    onKeyDown: (event) => {
      if (menuRef.current.handleKeyDown(event)) return
      if (recallKeyDown(event)) return
      if (followUpGhost) {
        const range = promptEditor.selection()
        const action = followUpGhostAction(
          {
            key: event.key,
            shiftKey: event.shiftKey,
            altKey: event.altKey,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            isComposing: event.nativeEvent.isComposing,
          },
          range.start === range.end && range.end === promptEditor.visible.length,
        )
        if (action === 'accept') {
          event.preventDefault()
          acceptFollowUpRef.current(followUpGhost)
          return
        }
        if (action === 'dismiss') {
          event.preventDefault()
          setDismissedFollowUp(followUpGhost)
          return
        }
      }
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
  acceptFollowUpRef.current = (line) => {
    setDraft((current) => ({ ...current, prompt: line }))
    promptEditor.select(line.length, line.length)
  }

  const groups: SuggestionMenuGroup<ComposerSuggestion>[] =
    promptEditor.query?.kind === 'mention'
      ? buildAgentMentionGroups({
          query: promptEditor.query.query,
          references: draft.references,
          results,
          canvas: showCanvasReferences ? canvas : [],
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

    if (value.type === 'result') {
      const image = results.find((one) => one.id === value.imageId)
      if (!image) return
      const dataUrl = image.source ?? (await previewArtifactBitmap(image.artifact))
      // Loading an older result must not overwrite newer typing or attach to a switched chat.
      if (
        useAgentStore.getState().conversationId !== conversationId ||
        session.getSnapshot().draft !== draft ||
        promptEditor.cursor() !== at ||
        getAtImageQuery(promptEditor.visible, promptEditor.cursor())?.start !== active.start
      )
        return
      if (!dataUrl) {
        useStore.getState().showToast(t('mentions.resultUnavailable'), 'error')
        return
      }
      applyAttach(
        attachReference(
          draft,
          { id: image.id, dataUrl, name: image.label },
          active.start,
          at,
          transportRef.current,
        ),
      )
      return
    }

    // 素材需要取图；已有引用和画布图片直接插入胶囊。
    if (value.type === 'asset') {
      const attached = await attachAssetToDraft(
        draft,
        value.id,
        active.start,
        at,
        transportRef.current,
      )
      if (
        attached &&
        useAgentStore.getState().conversationId === conversationId &&
        session.getSnapshot().draft === draft &&
        promptEditor.cursor() === at
      )
        applyAttach(attached)
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
  const openingMask = useRef(false)
  const editMask = (reference: AgentReference) => {
    if (openingMask.current) return
    const sameAccount = accountScope()
    const current = () =>
      sameAccount() && session.getSnapshot().draft.references.includes(reference)
    const resolve = async (source: string): Promise<string> => {
      if (localAttachmentIdentity(source)) {
        const original = await readLocalAttachment(source)
        if (!current()) throw new Error('media_scope_changed')
        return blobDataUrl(new Blob([original.data], { type: original.contentType }))
      }
      return mediaIdentity(source) ? resolveMediaSource(source, 'original', true) : source
    }
    openingMask.current = true
    void (async () => {
      const target = await resolve(reference.dataUrl)
      const mask = reference.maskDataUrl ? await resolve(reference.maskDataUrl) : null
      if (!current()) return
      useStore.getState().openMaskEditorSession(reference.id, {
        maskDataUrl: mask,
        keepSemantics: false,
        targetDataUrl: target,
        onSave: ({ maskDataUrl, targetDataUrl }) => {
          if (!current()) return
          setDraft((draft) =>
            setReferenceMask(draft, reference.id, {
              maskDataUrl,
              dataUrl: targetDataUrl === target ? reference.dataUrl : targetDataUrl,
            }),
          )
        },
        onRemove: () => {
          if (current()) setDraft((draft) => clearReferenceMask(draft, reference.id))
        },
      })
    })()
      .catch(() => {
        if (current()) useStore.getState().showToast(t('composer.sendFailedToast'), 'error')
      })
      .finally(() => {
        openingMask.current = false
      })
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
    if (loading || submitting || historyBlocked || uploadsBlocked) return
    const submission = draftForSubmit(draft)
    if (!submission.text.trim()) return
    // 乐观发送：敲下回车输入框立刻清空，那句话已经在对话里了；服务端没收下再把草稿放回来。
    const snapshot = draft
    const handoff = hasLocalAttachmentSources(snapshot)
      ? attachmentSourceOwner(`sending:${crypto.randomUUID()}`)
      : undefined
    const releaseSubmission = session.beginSubmission()
    const sameAccount = accountScope()
    let stagedId: string | undefined
    let accepted = false
    let returnedToDraft = false
    const restore = (cancelled = false) => {
      returnedToDraft = true
      useStore
        .getState()
        .showToast(
          cancelled ? t('composer.abortedToast') : t('composer.sendFailedToast'),
          cancelled ? 'info' : 'error',
        )
      // 这几秒里用户要是已经开始打下一句，别把它冲掉。
      setDraft((current) =>
        current.prompt.trim() || current.references.length
          ? current
          : { ...snapshot, submission: undefined },
      )
    }
    const acceptLocalDraft = () => {
      if (stagedId) session.acceptSubmission(stagedId)
      else session.accept(snapshot)
      selection.sent()
      browsingRef.current = null
    }
    const send = () => {
      if (!sameAccount()) throw new Error('media_scope_changed')
      if (!handoff) acceptLocalDraft()
      return useAgentStore.getState().send(
        snapshot.submission?.text ?? submission.text,
        snapshot.submission?.references ?? submission.references,
        () => {
          accepted = true
          if (handoff) acceptLocalDraft()
          if (sameAccount()) rememberAgentPrompt(snapshot.prompt)
          releaseSubmission()
        },
        snapshot.submission?.mode ?? mode,
        snapshot.submission?.id,
        snapshot.submission,
        undefined,
        async (retry) => {
          returnedToDraft = true
          useStore.getState().showToast(t('composer.sendFailedToast'), 'error')
          return session.returnUnsent({ ...snapshot, submission: retry })
        },
        handoff
          ? {
              stage: async (command) => {
                if (!sameAccount()) throw new Error('media_scope_changed')
                stagedId = command.id
                await session.stageSubmission(snapshot, command)
              },
              committed: () => acceptLocalDraft(),
            }
          : undefined,
      )
    }
    void (handoff ? handoff.retain(snapshot).then(send) : send())
      .then(
        (outcome) => {
          if (!accepted && !returnedToDraft) restore(outcome === 'cancelled')
        },
        () => restore(),
      )
      .finally(async () => {
        try {
          await session.flush()
          if (!session.getSnapshot().error) await handoff?.release().catch(() => {})
        } finally {
          releaseSubmission()
        }
      })
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
        <div
          role="alert"
          className="flex items-center gap-2 rounded-lg bg-muted px-2.5 py-1 text-label-sm text-warning"
        >
          <span className="min-w-0 flex-1">
            {recoveryBlocked ? t('draft.recoveryBlocked') : draftError}
          </span>
          {recoveryBlocked && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className={`${ICON_BUTTON} size-auto shrink-0`}
              aria-label={t('draft.retryRestore')}
              title={t('draft.retryRestore')}
              disabled={readingDraft}
              onClick={() => void session.retryRecovery()}
            >
              <Icon name="refresh" />
            </Button>
          )}
        </div>
      )}
      {unsent && (recoverable || !hasDraftContent(draft)) && (
        <div
          role="status"
          className="flex items-center gap-2 rounded-lg bg-muted px-2.5 py-1 text-xs"
        >
          <span className={`shrink-0 text-label-sm ${INK_3}`}>{t('draft.unsent')}</span>
          <span className={`min-w-0 flex-1 truncate ${INK}`} title={unsent.prompt}>
            {unsent.prompt}
          </span>
          {unsent.references.length > 0 && (
            <span className={`shrink-0 text-label-sm ${INK_3}`}>
              {t('queue.references', { count: unsent.references.length })}
            </span>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className={`${ICON_BUTTON} size-auto shrink-0`}
            aria-label={t('draft.restore')}
            title={t('draft.restore')}
            disabled={loading}
            onClick={session.restoreUnsent}
          >
            <Icon name="undo" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className={`${ICON_BUTTON} size-auto shrink-0`}
            aria-label={t('draft.discard')}
            title={t('draft.discard')}
            disabled={loading}
            onClick={session.discardUnsent}
          >
            <Icon name="close" />
          </Button>
        </div>
      )}
      <CreationFrame className={dragging ? 'ring-2 ring-primary' : ''}>
        {productionMode && (
          <ProductionQuoteChip
            conversationId={conversationId}
            frozenContext={draft.submission?.params?.production}
            onRemove={() => setDraft((current) => ({ ...current, submission: undefined }))}
          />
        )}
        <CreationBody
          references={
            <CreationReferenceStack
              count={draft.references.length}
              disabled={loading}
              onClear={() =>
                setDraft((current) => {
                  let next = current
                  for (let index = current.references.length - 1; index >= 0; index--) {
                    next = removeReference(next, index)
                  }
                  return next
                })
              }
              failed={Boolean(failedReference)}
              uploading={uploadingCount > 0}
              status={referenceStatus}
              previews={draft.references
                .slice(-3)
                .map((reference) => (
                  <ComposerAttachmentThumb
                    key={reference.id}
                    src={reference.dataUrl}
                    className="h-full w-full object-cover"
                    frameClassName="h-full w-full"
                    alt={reference.name ?? ''}
                  />
                ))}
              add={
                <Button
                  variant="ghost"
                  className="creation-add"
                  aria-label={t('composer.attachAria')}
                  title={t('composer.attachTitle', { count: API_MAX_IMAGES, mb: MAX_IMAGE_MB })}
                  aria-haspopup="menu"
                  aria-expanded={attachMenu !== null}
                  disabled={loading}
                  onClick={(event) => {
                    const bounds = event.currentTarget.getBoundingClientRect()
                    setAttachMenu({ x: bounds.left, y: bounds.top - ATTACH_MENU_HEIGHT })
                  }}
                >
                  <Icon name="add" />
                  <span>{t('composer:studio.reference')}</span>
                </Button>
              }
            >
              {draft.references.length > 0 && (
                <ComposerAttachments className="w-full">
                  {selectionSummary.length > 0 && (
                    <div className="flex max-w-full items-center gap-2 rounded-lg border border-border bg-muted/60 p-1 pr-1.5">
                      <div className="flex -space-x-3">
                        {selectionSummary.slice(0, AGENT_TURN_ATTACHED_MEDIA_MAX).map((one) => (
                          <ComposerAttachmentThumb
                            key={one.id}
                            src={one.dataUrl}
                            className={`${STRIP_THUMB} ring-2 ring-muted`}
                          />
                        ))}
                      </div>
                      <span className="whitespace-nowrap text-xs text-foreground">
                        {t('composer.selectionSummary', { count: selectionSummary.length })}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={t('composer.clearSelectionAria')}
                        className={`${ICON_BUTTON} size-auto shrink-0`}
                        onClick={() => setDraft(removeSelectionReferences(draft))}
                      >
                        <Icon name="close" />
                      </Button>
                    </div>
                  )}
                  {draft.references.map((reference, index) => {
                    if (
                      selectionSummary.length > 0 &&
                      reference.origin === 'selection' &&
                      !attachmentUploadState(uploadReference(reference))
                    )
                      return null
                    const label = referenceNames[index] ?? getImageMentionLabel(index)
                    const masked = Boolean(reference.maskDataUrl)
                    const uploadState = attachmentUploadState(uploadReference(reference))
                    const uploadError = attachmentUploadError(uploadReference(reference))
                    const isUploading = ['queued', 'uploading', 'verifying'].includes(
                      uploadState ?? '',
                    )
                    return (
                      <div key={reference.id} className="group flex max-w-full items-start gap-2">
                        <CreationReferencePreview src={reference.dataUrl} label={label}>
                          <AttachmentTile
                            name={label}
                            title={label}
                            failed={uploadState === 'failed'}
                            className="size-[72px]"
                          >
                            <ComposerAttachmentThumb
                              src={reference.dataUrl}
                              uploading={isUploading}
                              failed={uploadState === 'failed'}
                              frameClassName="h-full w-full"
                              className={`h-full w-full object-contain ${masked ? 'ring-1 ring-ring/70' : ''}`}
                              alt={label}
                              retryPreview
                            />
                            {masked && (
                              <span className="pointer-events-none absolute left-0.5 top-0.5 rounded bg-primary/90 px-1 py-px text-label-sm font-semibold leading-none tracking-wider text-primary-foreground">
                                MASK
                              </span>
                            )}
                            {uploadState === 'failed' && (
                              <span
                                aria-hidden="true"
                                className="pointer-events-none absolute inset-0 grid place-items-center text-destructive"
                              >
                                <Icon name="error" size="lg" />
                              </span>
                            )}
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={
                                masked
                                  ? t('composer.editMaskAria', { label })
                                  : t('composer.drawMaskAria', { label })
                              }
                              className="absolute bottom-0 left-0 h-11 w-11 rounded-none bg-transparent text-foreground opacity-0 hover:bg-transparent group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
                              onClick={() => editMask(reference)}
                            >
                              <span className="grid h-6 w-6 place-items-center rounded-full border border-border/70 bg-background/90 shadow-sm">
                                <Icon name="brush" />
                              </span>
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={t('composer.removeReferenceAria', { label })}
                              className="absolute right-0 top-0 z-20 h-11 w-11 rounded-none bg-transparent text-foreground opacity-0 hover:bg-transparent group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
                              onClick={() => setDraft(removeReference(draft, index))}
                            >
                              <span className="grid h-6 w-6 place-items-center rounded-full border border-border/70 bg-background/90 shadow-sm">
                                <Icon name="close" />
                              </span>
                            </Button>
                          </AttachmentTile>
                        </CreationReferencePreview>
                        {uploadState && (
                          <span
                            role={uploadState === 'failed' ? 'alert' : 'status'}
                            className={
                              uploadState === 'failed'
                                ? 'max-w-56 self-center text-xs text-destructive'
                                : 'sr-only'
                            }
                          >
                            {uploadState === 'failed'
                              ? `${label}：${attachmentUploadErrorMessage(uploadError, getAttachmentLimits())}`
                              : t(`composer.upload.${uploadState}`)}
                          </span>
                        )}
                        {uploadState === 'failed' && canRetryAttachmentUpload(uploadError) && (
                          <Button
                            type="button"
                            variant="ghost"
                            className={`${GHOST_LINK} h-auto px-0 py-0 font-normal hover:bg-transparent`}
                            aria-label={t('composer.retryUploadAria', { label })}
                            onClick={() => retryUpload(reference)}
                          >
                            {t('composer.retryUpload')}
                          </Button>
                        )}
                      </div>
                    )
                  })}
                </ComposerAttachments>
              )}
            </CreationReferenceStack>
          }
        >
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
              aria-describedby={followUpGhost ? followUpHintId : undefined}
              disabled={loading}
              aria-busy={loading}
              placeholder={
                followUpGhost
                  ? undefined
                  : t(`composer:studio.placeholders.${productionMode ? 'video' : creationMode}`)
              }
              data-follow-up={followUpGhost ? '' : undefined}
              className="creation-prompt"
            />
            {followUpGhost && (
              <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-wrap items-center gap-2 text-base leading-[1.75]">
                <span className="min-w-0 text-muted-foreground" aria-hidden="true">
                  {followUpGhost}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className="pointer-events-auto h-7 px-2 font-normal text-muted-foreground"
                  aria-label={t('suggestions.followUpAccept')}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => acceptFollowUpRef.current(followUpGhost)}
                >
                  <span className="sm:hidden">{t('suggestions.followUpTap')}</span>
                  <span className="hidden sm:inline">Tab</span>
                </Button>
                <p id={followUpHintId} className="sr-only">
                  {t('suggestions.followUpHint', { text: followUpGhost })}
                </p>
              </div>
            )}
          </div>
        </CreationBody>
        <CreationToolbar
          mode={
            <CreationModePicker
              value={productionMode ? 'video' : creationMode}
              modes={
                productionMode
                  ? ['video']
                  : ['agent', 'image', ...(videoAvailable ? ['video' as const] : [])]
              }
              onChange={(next) => {
                const target = next === 'agent' ? 'chat' : next === 'video' ? 'video' : 'generate'
                useStore.setState((state) => ({
                  projectCreationTargets: {
                    ...state.projectCreationTargets,
                    [session.key]: target,
                  },
                }))
                useStore.getState().setCreateTarget(target)
              }}
            />
          }
          status={
            referenceStatus && (
              <span className={failedReference ? 'text-destructive' : 'text-muted-foreground'}>
                {referenceStatus}
              </span>
            )
          }
          action={
            <CreationSend
              busy={!stopMode && (uploadingCount > 0 || submitting)}
              streaming={stopMode}
              aria-label={
                stopMode
                  ? t('composer.abort')
                  : submitting
                    ? t('composer.sending')
                    : uploadsBlocked
                      ? (referenceStatus ?? t('composer.sendAndCreate'))
                      : running
                        ? t('composer.queue')
                        : t('composer.sendAndCreate')
              }
              title={
                stopMode
                  ? t('composer.abortTitle')
                  : uploadsBlocked
                    ? referenceStatus
                    : running
                      ? t('composer.queue')
                      : t('composer.sendAndCreateTitle')
              }
              disabled={
                stopMode
                  ? false
                  : historyBlocked ||
                    loading ||
                    submitting ||
                    uploadsBlocked ||
                    !draft.prompt.trim()
              }
              onClick={stopMode ? () => void useAgentStore.getState().abort() : submit}
            />
          }
        >
          {mode === 'video' && !productionMode ? (
            <CanvasVideoParams hasFirstFrame={false}>
              <AgentExecutionSettings />
            </CanvasVideoParams>
          ) : (
            <AgentParamsChip
              generationControls={!productionMode}
              thinkingControls={creationMode !== 'image'}
            />
          )}
        </CreationToolbar>
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
        {attachMenu && (
          <ContextMenu x={attachMenu.x} y={attachMenu.y} onClose={() => setAttachMenu(null)}>
            <ContextMenuItem
              icon={<Icon name="images" />}
              label={t('composer.attachImages')}
              onClick={() => {
                setAttachMenu(null)
                fileInputRef.current?.click()
              }}
            />
            <ContextMenuItem
              icon={<Icon name="folder" />}
              label={t('composer.attachFolder')}
              onClick={() => {
                setAttachMenu(null)
                folderInputRef.current?.click()
              }}
            />
          </ContextMenu>
        )}{' '}
      </CreationFrame>
    </Composer>
  )
}
