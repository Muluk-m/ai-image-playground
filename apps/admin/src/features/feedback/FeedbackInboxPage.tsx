import {
  FEEDBACK_MESSAGE_MAX_CHARS,
  type FeedbackAdminThreadSummary,
  type FeedbackMessage,
} from '@image-playground/shared'
import { Link } from '@tanstack/react-router'
import {
  CheckCircle2,
  ExternalLink,
  ImageIcon,
  Loader2,
  RotateCcw,
  Search,
  Send,
} from 'lucide-react'
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { EmptyState, ErrorState, Page, PendingState } from '@/components/Page'
import { SegmentedControl } from '@/components/SegmentedControl'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  type FeedbackFilter,
  type FeedbackSearch,
  feedbackAttachmentUrl,
  feedbackErrorMessage,
  formatFeedbackTime,
  useFeedbackMutations,
  useFeedbackThread,
  useFeedbackThreads,
} from '@/lib/feedback'
import { cn } from '@/lib/utils'

function threadDisplayName(thread: FeedbackAdminThreadSummary): string {
  return thread.nickname?.trim() || thread.username
}

function StatusIndicator({ thread }: { thread: FeedbackAdminThreadSummary }) {
  if (thread.status === 'resolved') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success">
        <span className="size-2 rounded-full bg-success" aria-hidden />
        已解决
      </span>
    )
  }
  if (thread.needsAdminReply) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-warning">
        <span className="size-2 rounded-full bg-warning" aria-hidden />
        待回复
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
      <span className="size-2 rounded-full bg-muted-foreground" aria-hidden />
      已回复
    </span>
  )
}

function MessageBubble({
  message,
  userName,
  onPreviewImage,
}: {
  message: FeedbackMessage
  userName: string
  onPreviewImage: (src: string, title: string) => void
}) {
  const isAdmin = message.senderType === 'admin'
  const attachmentSrc = message.attachment ? feedbackAttachmentUrl(message.id) : null
  const attachmentLabel = message.attachment?.filename || '反馈截图'

  return (
    <div className={cn('flex flex-col gap-1', isAdmin ? 'items-end' : 'items-start')}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>{isAdmin ? `运营回复（${message.senderLabel ?? 'admin'}）` : userName}</span>
        <span className="font-mono">{formatFeedbackTime(message.createdAt)}</span>
      </div>
      <div
        className={cn(
          'max-w-xl rounded-xl px-3.5 py-2.5 text-sm leading-relaxed',
          isAdmin ? 'bg-primary text-primary-foreground' : 'border bg-muted/60 text-foreground',
        )}
      >
        {message.body ? (
          <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{message.body}</p>
        ) : null}
        {attachmentSrc ? (
          <Button
            type="button"
            variant="ghost"
            autoTooltip={false}
            onClick={() => onPreviewImage(attachmentSrc, attachmentLabel)}
            className="mt-2 block h-auto overflow-hidden p-0 rounded-lg border bg-background transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`查看大图：${attachmentLabel}`}
          >
            <img
              src={attachmentSrc}
              alt={attachmentLabel}
              className="max-h-56 max-w-full object-cover"
              loading="lazy"
            />
          </Button>
        ) : null}
      </div>
    </div>
  )
}

export function FeedbackInboxPage({
  search,
  onSearchChange,
}: {
  search: FeedbackSearch
  onSearchChange: (next: Partial<FeedbackSearch>) => void
}) {
  const listQuery = useFeedbackThreads(search)
  const items = listQuery.data?.items ?? []
  const counts = listQuery.data?.counts

  const activeThreadId =
    search.thread && items.some((item) => item.id === search.thread) ? search.thread : items[0]?.id

  const detailQuery = useFeedbackThread(activeThreadId)
  const { reply, setStatus } = useFeedbackMutations()

  const [draftQuery, setDraftQuery] = useState(search.q ?? '')
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({})
  const replyDraft = replyDrafts[activeThreadId ?? ''] ?? ''
  const [actionError, setActionError] = useState('')
  const [previewImage, setPreviewImage] = useState<{ src: string; title: string } | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setDraftQuery(search.q ?? '')
  }, [search.q])

  useEffect(() => {
    setActionError('')
  }, [activeThreadId])

  useEffect(() => {
    if (detailQuery.data?.messages.length) {
      messagesEndRef.current?.scrollIntoView?.({ block: 'end' })
    }
  }, [detailQuery.data?.messages.length, activeThreadId])

  const activeFilter: FeedbackFilter = search.filter ?? 'all'
  const filterOptions: Array<{ value: FeedbackFilter; label: string }> = [
    { value: 'all', label: counts ? `全部 ${counts.all}` : '全部' },
    { value: 'awaiting_reply', label: counts ? `待回复 ${counts.awaitingReply}` : '待回复' },
    { value: 'open', label: counts ? `处理中 ${counts.open}` : '处理中' },
    { value: 'resolved', label: counts ? `已解决 ${counts.resolved}` : '已解决' },
  ]

  function handleSearchSubmit(event: FormEvent) {
    event.preventDefault()
    onSearchChange({ q: draftQuery.trim() || undefined })
  }

  async function handleSendReply() {
    if (!activeThreadId || !replyDraft.trim() || reply.isPending) return
    setActionError('')
    try {
      await reply.mutateAsync({ threadId: activeThreadId, body: replyDraft.trim() })
      setReplyDrafts((drafts) => ({ ...drafts, [activeThreadId]: '' }))
    } catch (error) {
      setActionError(feedbackErrorMessage(error))
    }
  }

  function handleReplyKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      void handleSendReply()
    }
  }

  async function handleToggleStatus(thread: FeedbackAdminThreadSummary) {
    if (setStatus.isPending) return
    setActionError('')
    try {
      await setStatus.mutateAsync({
        threadId: thread.id,
        status: thread.status === 'resolved' ? 'open' : 'resolved',
      })
    } catch (error) {
      setActionError(feedbackErrorMessage(error))
    }
  }

  const activeThread = detailQuery.data?.thread
  const activeMessages = detailQuery.data?.messages ?? []

  return (
    <Page crumbs={[{ label: '经营' }, { label: '用户反馈' }]}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl
          label="按处理状态筛选"
          options={filterOptions}
          value={activeFilter}
          onChange={(next) =>
            onSearchChange({ filter: next === 'all' ? undefined : next, thread: undefined })
          }
        />

        <form onSubmit={handleSearchSubmit} className="flex items-center gap-2">
          <div className="relative w-64 max-w-full">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={draftQuery}
              onChange={(event) => setDraftQuery(event.target.value)}
              placeholder="搜索用户或反馈内容"
              className="pl-8"
              aria-label="搜索用户或反馈内容"
            />
          </div>
          <Button type="submit" variant="outline" size="sm">
            搜索
          </Button>
          {search.q ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraftQuery('')
                onSearchChange({ q: undefined })
              }}
            >
              清空
            </Button>
          ) : null}
        </form>
      </div>

      {listQuery.isPending ? (
        <PendingState label="正在加载反馈列表" />
      ) : listQuery.isError ? (
        <ErrorState label="反馈列表加载失败" error={listQuery.error} />
      ) : items.length === 0 ? (
        <EmptyState label={search.q || search.filter ? '当前筛选条件下没有反馈' : '暂无用户反馈'} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
          <section
            aria-label="反馈会话列表"
            className="flex max-h-[calc(100vh-220px)] flex-col overflow-hidden rounded-xl border bg-card"
          >
            <div className="divide-y overflow-y-auto">
              {items.map((item) => {
                const selected = item.id === activeThreadId
                const displayName = threadDisplayName(item)
                return (
                  <Button
                    key={item.id}
                    type="button"
                    variant="ghost"
                    aria-pressed={selected}
                    onClick={() => onSearchChange({ thread: item.id })}
                    className={cn(
                      'flex h-auto w-full flex-col items-stretch gap-1.5 whitespace-normal rounded-none p-4 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                      selected && 'bg-muted',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-foreground">
                        {displayName}
                      </span>
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">
                        {formatFeedbackTime(item.lastMessageAt)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-xs text-muted-foreground">
                        {item.username}
                      </span>
                      <StatusIndicator thread={item} />
                    </div>
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      {item.lastMessageHasAttachment ? (
                        <ImageIcon className="size-3.5 shrink-0" aria-hidden />
                      ) : null}
                      <span className="line-clamp-2 [overflow-wrap:anywhere]">
                        {item.lastMessagePreview}
                      </span>
                    </div>
                  </Button>
                )
              })}
            </div>
          </section>

          <section
            aria-label="反馈详情与回复"
            className="flex min-h-[480px] max-h-[calc(100vh-220px)] flex-col overflow-hidden rounded-xl border bg-card"
          >
            {detailQuery.isPending ? (
              <PendingState label="正在加载会话详情" className="flex-1" />
            ) : detailQuery.isError ? (
              <div className="p-4">
                <ErrorState label="会话详情加载失败" error={detailQuery.error} />
              </div>
            ) : !activeThread ? (
              <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
                选择左侧会话查看详情
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h2 className="truncate text-base font-semibold text-foreground">
                        {threadDisplayName(activeThread)}
                      </h2>
                      <StatusIndicator thread={activeThread} />
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-mono">{activeThread.username}</span>
                      <span>·</span>
                      <span>共 {activeThread.messageCount} 条消息</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button variant="outline" size="sm" asChild>
                      <Link to="/users/$userId" params={{ userId: activeThread.userId }}>
                        <ExternalLink className="size-3.5" />
                        <span>查看用户</span>
                      </Link>
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={setStatus.isPending}
                      onClick={() => void handleToggleStatus(activeThread)}
                    >
                      {activeThread.status === 'resolved' ? (
                        <>
                          <RotateCcw className="size-3.5" />
                          <span>重新打开</span>
                        </>
                      ) : (
                        <>
                          <CheckCircle2 className="size-3.5" />
                          <span>标记已解决</span>
                        </>
                      )}
                    </Button>
                  </div>
                </div>

                <div className="flex-1 space-y-4 overflow-y-auto p-4">
                  {activeMessages.map((message) => (
                    <MessageBubble
                      key={message.id}
                      message={message}
                      userName={threadDisplayName(activeThread)}
                      onPreviewImage={(src, title) => setPreviewImage({ src, title })}
                    />
                  ))}
                  <div ref={messagesEndRef} />
                </div>

                <div className="border-t p-4">
                  {actionError ? (
                    <p role="alert" className="mb-2 text-xs text-destructive">
                      {actionError}
                    </p>
                  ) : null}
                  <div className="flex flex-col gap-2">
                    <Textarea
                      value={replyDraft}
                      aria-label="回复内容"
                      onChange={(event) => {
                        const body = event.target.value
                        setReplyDrafts((drafts) => ({ ...drafts, [activeThread.id]: body }))
                      }}
                      onKeyDown={handleReplyKeyDown}
                      placeholder="输入回复内容，用户将在工作台反馈窗口收到…"
                      maxLength={FEEDBACK_MESSAGE_MAX_CHARS}
                      rows={3}
                      disabled={reply.isPending}
                    />
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-muted-foreground">⌘ / Ctrl + Enter 发送</span>
                      <Button
                        type="button"
                        variant="brand"
                        size="sm"
                        disabled={!replyDraft.trim() || reply.isPending}
                        onClick={() => void handleSendReply()}
                      >
                        {reply.isPending ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Send className="size-4" />
                        )}
                        <span>发送回复</span>
                      </Button>
                    </div>
                  </div>
                </div>
              </>
            )}
          </section>
        </div>
      )}

      <Dialog open={Boolean(previewImage)} onOpenChange={(open) => !open && setPreviewImage(null)}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle className="truncate">{previewImage?.title ?? '反馈截图'}</DialogTitle>
          </DialogHeader>
          {previewImage ? (
            <div className="flex max-h-[75vh] items-center justify-center overflow-auto rounded-lg bg-muted/40 p-2">
              <img
                src={previewImage.src}
                alt={previewImage.title}
                className="max-h-[70vh] max-w-full object-contain"
              />
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </Page>
  )
}
