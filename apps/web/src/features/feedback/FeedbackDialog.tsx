import {
  FEEDBACK_ATTACHMENT_ACCEPT,
  FEEDBACK_ATTACHMENT_MAX_BYTES,
  FEEDBACK_MESSAGE_MAX_CHARS,
  FEEDBACK_MESSAGE_PAGE_SIZE,
  type FeedbackMessage,
  isFeedbackAttachmentMimeType,
} from '@image-playground/shared'
import {
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from 'react'
import { useAuth } from '../../auth/AuthContext'
import { ImagePreview } from '../../components/Lightbox'
import Dialog from '../../components/patterns/Dialog'
import EmptyState from '../../components/patterns/EmptyState'
import { Button } from '../../components/ui/button'
import { Icon } from '../../components/ui/icon'
import { Textarea } from '../../components/ui/textarea'
import { useTranslation } from '../../i18n'
import { cn } from '../../lib/utils'
import { useStore } from '../../store'
import {
  FeedbackClientError,
  fetchFeedbackAttachmentBlobUrl,
  fetchFeedbackThread,
  markFeedbackRead,
  sendFeedbackMessage,
} from './client'

function formatMessageTime(timestamp: number, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale.startsWith('en') ? 'en-US' : 'zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(timestamp))
  } catch {
    return ''
  }
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function normalizeMime(type: string): string {
  const lower = type.trim().toLowerCase()
  return lower === 'image/jpg' ? 'image/jpeg' : lower
}

function AttachmentPreview({
  messageId,
  filename,
}: {
  messageId: string
  filename: string | null
}) {
  const { t } = useTranslation('shell')
  const [src, setSrc] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const request = useRef<AbortController | null>(null)

  useEffect(() => () => request.current?.abort(), [])
  useEffect(
    () => () => {
      if (src) URL.revokeObjectURL(src)
    },
    [src],
  )

  async function open() {
    if (request.current) return
    const controller = new AbortController()
    request.current = controller
    setFailed(false)
    setPending(true)
    try {
      const url = await fetchFeedbackAttachmentBlobUrl(messageId, controller.signal)
      if (controller.signal.aborted) URL.revokeObjectURL(url)
      else setSrc(url)
    } catch {
      if (!controller.signal.aborted) setFailed(true)
    } finally {
      request.current = null
      if (!controller.signal.aborted) setPending(false)
    }
  }

  return (
    <div className="mt-2">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={pending}
        className="max-w-full"
        onClick={() => void open()}
      >
        <Icon
          name={pending ? 'loading' : 'imageAdd'}
          className={pending ? 'animate-spin' : undefined}
        />
        <span className="truncate">{filename ?? t('header.feedback.attachmentAlt')}</span>
        <span>{t('header.feedback.previewAttachment')}</span>
      </Button>
      {failed && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {t('header.feedback.attachmentLoadFailed')}
        </p>
      )}
      {src && <ImagePreview src={src} tier="artifact" onClose={() => setSrc(null)} />}
    </div>
  )
}

export default function FeedbackDialog({
  onClose,
  onUnreadChange,
}: {
  onClose: () => void
  onUnreadChange?: (count: number) => void
}) {
  const { t, i18n } = useTranslation('shell')
  const auth = useAuth()
  const canUseInApp = Boolean(auth.user)

  const [{ messages, hasOlder }, setHistory] = useState<{
    messages: FeedbackMessage[]
    hasOlder: boolean
  }>({ messages: [], hasOlder: false })
  const [before, setBefore] = useState<number>()
  const [readAttempt, setReadAttempt] = useState(0)
  const acknowledgedReply = useRef<string | undefined>(undefined)
  const [loading, setLoading] = useState(canUseInApp)
  const [loadError, setLoadError] = useState(false)
  const [draft, setDraft] = useState('')
  const [attachment, setAttachment] = useState<File | null>(null)
  const [attachmentPreviewUrl, setAttachmentPreviewUrl] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [unread, setUnread] = useState(0)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const listEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!attachment) {
      setAttachmentPreviewUrl(null)
      return
    }
    const url = URL.createObjectURL(attachment)
    setAttachmentPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [attachment])

  useEffect(() => {
    if (!canUseInApp) return
    const controller = new AbortController()
    let refreshing = false
    let loaded = false
    let after: number | undefined
    const refresh = async () => {
      if (refreshing || document.hidden || (before !== undefined && loaded)) return
      refreshing = true
      try {
        const requestedAfter = after
        const data = await fetchFeedbackThread({ before, after: requestedAfter }, controller.signal)
        if (controller.signal.aborted) return
        loaded = true
        setLoadError(false)
        setUnread(data.thread?.unreadReplyCount ?? 0)
        setReadAttempt((attempt) => attempt + 1)
        setHistory((current) => {
          if (before !== undefined) {
            return { messages: data.messages, hasOlder: data.hasMore }
          }
          const fetchedIds = new Set(data.messages.map((message) => message.id))
          const merged = [
            ...current.messages.filter((message) => !fetchedIds.has(message.id)),
            ...data.messages,
          ].sort((a, b) => a.createdAt - b.createdAt)
          return {
            messages: merged.slice(-FEEDBACK_MESSAGE_PAGE_SIZE),
            hasOlder:
              current.hasOlder ||
              merged.length > FEEDBACK_MESSAGE_PAGE_SIZE ||
              (requestedAfter === undefined && data.hasMore),
          }
        })
        if (before === undefined) {
          after = data.messages[data.messages.length - 1]?.createdAt ?? after
        }
      } catch {
        if (!loaded && !controller.signal.aborted) setLoadError(true)
      } finally {
        if (!controller.signal.aborted) setLoading(false)
        refreshing = false
      }
    }
    void refresh()
    const timer = window.setInterval(refresh, 30_000)
    const resume = () => void refresh()
    document.addEventListener('visibilitychange', resume)
    return () => {
      controller.abort()
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [before, canUseInApp, reload])

  let latestReplyId: string | undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.senderType === 'admin') {
      latestReplyId = message.id
      break
    }
  }
  useEffect(() => {
    if (!canUseInApp || loading || loadError) return
    onUnreadChange?.(unread)
    if (
      before !== undefined ||
      !latestReplyId ||
      unread === 0 ||
      acknowledgedReply.current === latestReplyId ||
      document.hidden
    )
      return
    const controller = new AbortController()
    void markFeedbackRead(latestReplyId, controller.signal)
      .then(({ unreadReplyCount }) => {
        if (controller.signal.aborted) return
        acknowledgedReply.current = latestReplyId
        setUnread(unreadReplyCount)
      })
      .catch(() => {})
    return () => controller.abort()
  }, [before, canUseInApp, latestReplyId, loadError, loading, onUnreadChange, readAttempt, unread])

  const newestMessage = messages[messages.length - 1]
  useEffect(() => {
    if (!loading && newestMessage) {
      listEndRef.current?.scrollIntoView?.({ block: 'end' })
    }
  }, [loading, newestMessage?.id])

  const pickFile = (file: File | null | undefined) => {
    if (!file) return
    setErrorText(null)
    const normalizedType = normalizeMime(file.type)
    if (!isFeedbackAttachmentMimeType(normalizedType)) {
      setErrorText(t('header.feedback.errors.attachmentType'))
      return
    }
    if (file.size <= 0 || file.size > FEEDBACK_ATTACHMENT_MAX_BYTES) {
      setErrorText(t('header.feedback.errors.attachmentTooLarge'))
      return
    }
    setAttachment(file)
  }

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    pickFile(event.target.files?.[0])
    event.target.value = ''
  }

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = event.clipboardData?.items
    if (!items) return
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) {
          event.preventDefault()
          pickFile(file)
          break
        }
      }
    }
  }

  const mapSubmitError = (error: unknown): string => {
    if (error instanceof FeedbackClientError) {
      if (error.code === 'attachment_type') return t('header.feedback.errors.attachmentType')
      if (error.code === 'attachment_too_large') {
        return t('header.feedback.errors.attachmentTooLarge')
      }
      if (error.code === 'attachment_invalid') return t('header.feedback.errors.attachmentInvalid')
      if (error.code === 'body_too_long') return t('header.feedback.errors.bodyTooLong')
      if (error.code === 'rate_limited') return t('header.feedback.errors.rateLimited')
    }
    return t('header.feedback.errors.sendFailed')
  }

  const handleSubmit = async () => {
    const trimmed = draft.trim()
    if ((!trimmed && !attachment) || submitting || loading || loadError) return
    if (trimmed.length > FEEDBACK_MESSAGE_MAX_CHARS) {
      setErrorText(t('header.feedback.errors.bodyTooLong'))
      return
    }
    setSubmitting(true)
    setErrorText(null)
    try {
      const response = await sendFeedbackMessage({ body: trimmed, attachment })
      if (before !== undefined) {
        showPage(undefined)
      } else {
        setHistory((current) => {
          if (current.messages.some((message) => message.id === response.message.id)) return current
          const next = [...current.messages, response.message].sort(
            (a, b) => a.createdAt - b.createdAt,
          )
          return {
            messages: next.slice(-FEEDBACK_MESSAGE_PAGE_SIZE),
            hasOlder: current.hasOlder || next.length > FEEDBACK_MESSAGE_PAGE_SIZE,
          }
        })
      }
      setDraft('')
      setAttachment(null)
    } catch (error) {
      setErrorText(mapSubmitError(error))
    } finally {
      setSubmitting(false)
    }
  }

  function showPage(cursor: number | undefined) {
    setLoading(true)
    setHistory({ messages: [], hasOlder: false })
    setBefore(cursor)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      void handleSubmit()
    }
  }

  const canSend =
    (draft.trim().length > 0 || attachment !== null) && !submitting && !loading && !loadError

  const hasUnsentDraft = draft.trim().length > 0 || attachment !== null
  const requestClose = () => {
    if (submitting) return
    if (!hasUnsentDraft) {
      onClose()
      return
    }
    useStore.getState().setConfirmDialog({
      title: t('header.feedback.discardTitle'),
      message: t('header.feedback.discardMessage'),
      tone: 'danger',
      action: onClose,
    })
  }

  return (
    <>
      <Dialog
        onClose={requestClose}
        tier="artifact"
        title={t('header.feedback.label')}
        className="max-w-xl"
      >
        <div className="flex flex-col gap-4">
          {!auth.user ? (
            <div className="flex flex-col gap-4">
              <EmptyState
                icon={<Icon name="feedback" size="lg" />}
                title={t('header.feedback.signInTitle')}
                description={t('header.feedback.signInHint')}
                action={
                  auth.enabled ? (
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => {
                        onClose()
                        auth.login()
                      }}
                    >
                      {t('header.login')}
                    </Button>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <>
              {(before !== undefined || hasOlder) && (
                <div className="flex justify-end gap-2">
                  {before !== undefined && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => showPage(undefined)}
                    >
                      {t('header.feedback.latest')}
                    </Button>
                  )}
                  {hasOlder && messages[0] && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={loading}
                      onClick={() => showPage(messages[0]?.createdAt)}
                    >
                      {t('header.feedback.older')}
                    </Button>
                  )}
                </div>
              )}
              <div className="flex min-h-60 max-h-80 flex-col gap-3 overflow-y-auto rounded-2xl border border-border bg-background p-4">
                {loading ? (
                  <div className="flex flex-1 items-center justify-center text-muted-foreground">
                    <Icon name="loading" size="lg" className="animate-spin" />
                  </div>
                ) : loadError ? (
                  <EmptyState
                    icon={<Icon name="error" size="lg" />}
                    title={t('header.feedback.loadFailed')}
                    action={
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setLoadError(false)
                          setLoading(true)
                          setReload((value) => value + 1)
                        }}
                      >
                        {t('route.retry')}
                      </Button>
                    }
                  />
                ) : messages.length === 0 ? (
                  <EmptyState
                    icon={<Icon name="feedback" size="lg" />}
                    title={t('header.feedback.emptyTitle')}
                    description={t('header.feedback.emptyHint')}
                  />
                ) : (
                  <>
                    {messages.map((message) => {
                      const isUser = message.senderType === 'user'
                      return (
                        <div
                          key={message.id}
                          className={cn(
                            'flex flex-col gap-1',
                            isUser ? 'items-end' : 'items-start',
                          )}
                        >
                          <div className="flex items-center gap-2 text-label-sm text-muted-foreground">
                            <span>
                              {isUser
                                ? t('header.feedback.senderYou')
                                : t('header.feedback.senderSupport')}
                            </span>
                            <span>{formatMessageTime(message.createdAt, i18n.language)}</span>
                          </div>
                          <div
                            className={cn(
                              'min-w-0 max-w-full sm:max-w-md rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed',
                              isUser
                                ? 'bg-primary/15 text-foreground'
                                : 'border border-border bg-card text-foreground',
                            )}
                          >
                            {message.body ? (
                              <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                                {message.body}
                              </p>
                            ) : null}
                            {message.attachment ? (
                              <AttachmentPreview
                                messageId={message.id}
                                filename={message.attachment.filename}
                              />
                            ) : null}
                          </div>
                        </div>
                      )
                    })}
                    <div ref={listEndRef} />
                  </>
                )}
              </div>

              <div className="flex flex-col gap-3 rounded-2xl border border-border bg-background p-3">
                <Textarea
                  aria-label={t('header.feedback.placeholder')}
                  value={draft}
                  onChange={(event) => {
                    setDraft(event.target.value)
                    if (errorText) setErrorText(null)
                  }}
                  onPaste={handlePaste}
                  onKeyDown={handleKeyDown}
                  placeholder={t('header.feedback.placeholder')}
                  maxLength={FEEDBACK_MESSAGE_MAX_CHARS}
                  rows={3}
                  disabled={submitting}
                  className="resize-none border-0 bg-transparent p-1 shadow-none focus-visible:ring-0"
                />

                {attachment ? (
                  <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-2">
                    {attachmentPreviewUrl ? (
                      <img
                        src={attachmentPreviewUrl}
                        alt={attachment.name}
                        className="size-10 shrink-0 rounded-lg border border-border object-cover"
                      />
                    ) : (
                      <Icon name="imageAdd" className="shrink-0 text-muted-foreground" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium text-foreground">
                        {attachment.name}
                      </div>
                      <div className="text-label-sm text-muted-foreground">
                        {formatFileSize(attachment.size)}
                      </div>
                    </div>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      aria-label={t('header.feedback.removeAttachment')}
                      disabled={submitting}
                      onClick={() => setAttachment(null)}
                    >
                      <Icon name="close" />
                    </Button>
                  </div>
                ) : null}

                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept={FEEDBACK_ATTACHMENT_ACCEPT}
                      className="hidden"
                      onChange={handleFileChange}
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={submitting}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Icon name="imageAdd" />
                      <span>{t('header.feedback.addImage')}</span>
                    </Button>
                    <span className="text-label-sm text-muted-foreground">
                      {t('header.feedback.imageLimit')}
                    </span>
                  </div>

                  <Button
                    type="button"
                    size="sm"
                    disabled={!canSend}
                    onClick={() => void handleSubmit()}
                  >
                    {submitting ? (
                      <Icon name="loading" className="animate-spin" />
                    ) : (
                      <Icon name="send" />
                    )}
                    <span>{t('header.feedback.send')}</span>
                  </Button>
                </div>
              </div>

              {errorText ? (
                <p role="alert" className="text-xs text-destructive">
                  {errorText}
                </p>
              ) : null}
            </>
          )}
        </div>
      </Dialog>
    </>
  )
}
