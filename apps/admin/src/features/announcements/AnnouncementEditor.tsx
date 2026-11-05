import type {
  AnnouncementAudience,
  AnnouncementDraft,
  AnnouncementImportance,
  AnnouncementLocale,
  AnnouncementType,
} from '@image-playground/shared'
import { ANNOUNCEMENT_TITLE_MAX, isInSitePath } from '@image-playground/shared'
import { useNavigate } from '@tanstack/react-router'
import { Bold, Download, Eye, Heading2, Link2, List, Send } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { DateTimePicker } from '@/components/DateTimePicker'
import { Page, PendingState } from '@/components/Page'
import { SegmentedControl } from '@/components/SegmentedControl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  AUDIENCE_LABEL,
  announcementErrorMessage,
  draftFromItem,
  emptyAnnouncementDraft,
  epochToLocalInput,
  exportAnnouncement,
  localInputToEpoch,
  STATUS_LABEL,
  useAnnouncement,
  useAnnouncementMutations,
  useAnnouncements,
} from '@/lib/announcements'
import { uploadInspirationAsset } from '@/lib/inspirations'
import { AnnouncementPreview } from './AnnouncementPreview'
import { ReasonDialog } from './ReasonDialog'

type PublishMode = 'now' | 'schedule'
type Action = 'publish' | 'unpublish' | 'archive' | null

function draftKey(draft: AnnouncementDraft): string {
  return JSON.stringify(draft)
}

export function AnnouncementEditor({ id }: { id: string }) {
  const navigate = useNavigate()
  const loaded = useAnnouncement(id === 'new' ? undefined : id)
  const list = useAnnouncements({})
  const mutations = useAnnouncementMutations()
  const [draft, setDraft] = useState<AnnouncementDraft>(emptyAnnouncementDraft)
  const [publishMode, setPublishMode] = useState<PublishMode>('now')
  const [publishInput, setPublishInput] = useState('')
  const [expireInput, setExpireInput] = useState('')
  const [localeTab, setLocaleTab] = useState<AnnouncementLocale>('zh')
  const [previewLocale, setPreviewLocale] = useState<AnnouncementLocale>('zh')
  const [previewTheme, setPreviewTheme] = useState<'dark' | 'light'>('dark')
  const [previewMode, setPreviewMode] = useState<'list' | 'modal'>('list')
  const [savedKey, setSavedKey] = useState('')
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [coverUrl, setCoverUrl] = useState<string | null>(null)
  const [action, setAction] = useState<Action>(null)
  const [uploading, setUploading] = useState(false)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const creating = useRef(false)
  const webOrigin = loaded.data?.webOrigin ?? list.data?.webOrigin ?? null

  useEffect(() => {
    const item = loaded.data?.item
    if (!item) return
    const next = draftFromItem(item)
    setDraft(next)
    setSavedKey(draftKey(next))
    setCoverUrl(item.coverUrl)
    setPublishMode(item.publishAt && item.publishAt > Date.now() ? 'schedule' : 'now')
    setPublishInput(epochToLocalInput(item.publishAt))
    setExpireInput(epochToLocalInput(item.expireAt))
    setSavedAt(item.updatedAt)
  }, [loaded.data?.item])

  const currentDraft = normalizeDraft(draft, publishMode, publishInput, expireInput)
  const dirty =
    id === 'new' ? currentDraft.titleZh.trim().length > 0 : draftKey(currentDraft) !== savedKey

  useEffect(() => {
    if (!dirty || action) return
    const timer = window.setTimeout(() => {
      void persist(false)
    }, 800)
    return () => window.clearTimeout(timer)
    // persist closes over the latest draft; the key is the serialized form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, draftKey(currentDraft), id])

  async function persist(manual: boolean): Promise<string | null> {
    const next = normalizeDraft(draft, publishMode, publishInput, expireInput)
    if (!next.titleZh.trim()) {
      if (manual) setError('先写标题')
      return null
    }
    if (
      (next.ctaLabel == null) !== (next.ctaUrl == null) ||
      (next.ctaUrl && !isInSitePath(next.ctaUrl))
    ) {
      if (manual) setError('按钮文案和站内链接要一起填，链接只能是站内路径')
      return null
    }
    setError('')
    try {
      if (id === 'new') {
        if (creating.current) return null
        creating.current = true
        const created = await mutations.create.mutateAsync(next)
        setSavedKey(draftKey(next))
        setSavedAt(Date.now())
        void navigate({ to: '/announcements/$id', params: { id: created.item.id }, replace: true })
        return created.item.id
      }
      const updated = await mutations.update.mutateAsync({ id, draft: next })
      setSavedKey(draftKey(draftFromItem(updated.item)))
      setDraft(draftFromItem(updated.item))
      setSavedAt(Date.now())
      return id
    } catch (saveError) {
      setError(announcementErrorMessage(saveError))
      creating.current = false
      return null
    }
  }

  function patch(partial: Partial<AnnouncementDraft>) {
    setDraft((previous) => ({ ...previous, ...partial }))
  }

  function insertMarkdown(prefix: string, suffix = '') {
    const field = bodyRef.current
    const key = localeTab === 'zh' ? 'bodyZh' : 'bodyEn'
    const source = (localeTab === 'zh' ? draft.bodyZh : draft.bodyEn) ?? ''
    if (!field) {
      patch({ [key]: `${source}${prefix}${suffix}` })
      return
    }
    const start = field.selectionStart
    const end = field.selectionEnd
    const selected = source.slice(start, end) || '文字'
    const next = `${source.slice(0, start)}${prefix}${selected}${suffix}${source.slice(end)}`
    patch({ [key]: next })
  }

  const item = loaded.data?.item
  const status = item?.effectiveStatus ?? 'draft'
  const previewOnSite = webOrigin ? `${webOrigin}/changelog` : ''
  const siteLabel = webOrigin?.includes('test') ? '在测试站打开' : '在主站预览'

  return (
    <Page
      crumbs={[
        { label: '运营内容' },
        { label: '版本公告', to: '/announcements' },
        { label: id === 'new' ? '新建' : '编辑' },
      ]}
      title={draft.titleZh || '新建公告'}
      description={item ? `${STATUS_LABEL[status]} · ${item.updatedBy}` : '草稿会自动保存'}
      actions={
        <>
          {savedAt ? (
            <span className="text-xs text-muted-foreground">
              已自动保存 ·{' '}
              {new Date(savedAt).toLocaleTimeString('zh-CN', {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          ) : null}
          {previewOnSite ? (
            <Button type="button" variant="outline" size="sm" asChild>
              <a href={previewOnSite} target="_blank" rel="noopener">
                <Eye />
                {siteLabel}
              </a>
            </Button>
          ) : null}
          {id !== 'new' && item ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                const blob = new Blob([JSON.stringify(exportAnnouncement(item), null, 2)], {
                  type: 'application/json',
                })
                const url = URL.createObjectURL(blob)
                const anchor = document.createElement('a')
                anchor.href = url
                anchor.download = `${item.id}.json`
                anchor.click()
                URL.revokeObjectURL(url)
              }}
            >
              <Download />
              导出 JSON
            </Button>
          ) : null}
          <Button type="button" variant="outline" size="sm" onClick={() => void persist(true)}>
            存草稿
          </Button>
          {status === 'published' || status === 'scheduled' ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setAction('unpublish')}
            >
              撤回
            </Button>
          ) : null}
          {status !== 'archived' && id !== 'new' ? (
            <Button type="button" variant="outline" size="sm" onClick={() => setAction('archive')}>
              归档
            </Button>
          ) : null}
          {status !== 'archived' ? (
            <Button
              type="button"
              size="sm"
              className="bg-brand text-brand-foreground hover:bg-brand-hover"
              onClick={() => setAction('publish')}
            >
              <Send />
              发布
            </Button>
          ) : null}
        </>
      }
    >
      {id !== 'new' && loaded.isPending ? <PendingState label="正在加载公告" /> : null}
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <form
          className="space-y-4 rounded-xl border bg-card p-4"
          onSubmit={(event) => {
            event.preventDefault()
            void persist(true)
          }}
        >
          <div className="grid gap-4 md:grid-cols-3">
            <label className="space-y-1.5 text-xs font-medium">
              类型
              <SegmentedControl
                label="类型"
                value={draft.type}
                onChange={(type) => patch({ type: type as AnnouncementType })}
                options={[
                  { value: 'feature', label: '新功能' },
                  { value: 'improvement', label: '优化' },
                  { value: 'notice', label: '公告' },
                ]}
              />
            </label>
            <label className="space-y-1.5 text-xs font-medium">
              重要程度
              <SegmentedControl
                label="重要程度"
                value={draft.importance}
                onChange={(importance) =>
                  patch({ importance: importance as AnnouncementImportance })
                }
                options={[
                  { value: 'normal', label: '普通' },
                  { value: 'major', label: '重要 · 弹窗一次' },
                ]}
              />
            </label>
            <label className="space-y-1.5 text-xs font-medium">
              版本号
              <Input
                value={draft.versionTag ?? ''}
                maxLength={32}
                placeholder="v2.15.0"
                aria-label="版本号"
                onChange={(event) => patch({ versionTag: event.target.value || null })}
              />
            </label>
          </div>

          <div className="flex items-center gap-2">
            <SegmentedControl
              label="文案语言"
              value={localeTab}
              onChange={(value) => setLocaleTab(value as AnnouncementLocale)}
              options={[
                { value: 'zh', label: '中文' },
                { value: 'en', label: 'English' },
              ]}
            />
            {localeTab === 'en' && (!draft.titleEn?.trim() || !draft.bodyEn?.trim()) ? (
              <span className="rounded-md bg-warning/15 px-2 py-1 text-xs text-warning">
                未填写，将回退中文
              </span>
            ) : null}
          </div>

          <label className="block space-y-1.5 text-xs font-medium">
            <span className="flex justify-between">
              标题
              <span className="font-normal text-muted-foreground">
                {(localeTab === 'zh' ? draft.titleZh : (draft.titleEn ?? '')).length}/
                {ANNOUNCEMENT_TITLE_MAX}
              </span>
            </span>
            <Input
              value={localeTab === 'zh' ? draft.titleZh : (draft.titleEn ?? '')}
              maxLength={ANNOUNCEMENT_TITLE_MAX}
              aria-label="标题"
              onChange={(event) =>
                patch(
                  localeTab === 'zh'
                    ? { titleZh: event.target.value }
                    : { titleEn: event.target.value || null },
                )
              }
            />
          </label>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">正文 Markdown</span>
              <span className="flex gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="二级标题"
                  onClick={() => insertMarkdown('## ')}
                >
                  <Heading2 />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="加粗"
                  onClick={() => insertMarkdown('**', '**')}
                >
                  <Bold />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="列表"
                  onClick={() => insertMarkdown('\n- ')}
                >
                  <List />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="站内链接"
                  onClick={() => insertMarkdown('[', '](/path)')}
                >
                  <Link2 />
                </Button>
              </span>
            </div>
            <Textarea
              ref={bodyRef}
              value={localeTab === 'zh' ? draft.bodyZh : (draft.bodyEn ?? '')}
              aria-label="正文"
              className="min-h-40 font-mono text-xs leading-5"
              onChange={(event) =>
                patch(
                  localeTab === 'zh'
                    ? { bodyZh: event.target.value }
                    : { bodyEn: event.target.value || null },
                )
              }
            />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <span className="text-xs font-medium">封面图</span>
              {coverUrl ? (
                <img
                  src={coverUrl}
                  alt=""
                  className="aspect-video w-full rounded-md border object-cover"
                />
              ) : (
                <div className="grid aspect-video place-items-center rounded-md border border-dashed text-xs text-muted-foreground">
                  1600×900
                </div>
              )}
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" disabled={uploading} asChild>
                  <label>
                    {uploading ? '上传中' : '替换'}
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      className="hidden"
                      onChange={(event) => {
                        const file = event.target.files?.[0]
                        event.target.value = ''
                        if (!file) return
                        setUploading(true)
                        void uploadInspirationAsset(file)
                          .then((asset) => {
                            patch({ coverKey: asset.key })
                            setCoverUrl(asset.publicUrl)
                          })
                          .catch((uploadError) => setError(announcementErrorMessage(uploadError)))
                          .finally(() => setUploading(false))
                      }}
                    />
                  </label>
                </Button>
                {draft.coverKey ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      patch({ coverKey: null })
                      setCoverUrl(null)
                    }}
                  >
                    移除
                  </Button>
                ) : null}
              </div>
            </div>
            <div className="space-y-3">
              <label className="block space-y-1.5 text-xs font-medium">
                按钮文案
                <Input
                  value={draft.ctaLabel ?? ''}
                  maxLength={40}
                  aria-label="按钮文案"
                  onChange={(event) => patch({ ctaLabel: event.target.value || null })}
                />
              </label>
              <label className="block space-y-1.5 text-xs font-medium">
                站内链接
                <Input
                  value={draft.ctaUrl ?? ''}
                  placeholder="/toolbox/remove-bg"
                  aria-label="站内链接"
                  onChange={(event) => patch({ ctaUrl: event.target.value || null })}
                />
              </label>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <span className="text-xs font-medium">发布时间</span>
              <SegmentedControl
                label="发布时间"
                value={publishMode}
                onChange={(mode) => setPublishMode(mode as PublishMode)}
                options={[
                  { value: 'now', label: '立即' },
                  { value: 'schedule', label: '定时' },
                ]}
              />
              {publishMode === 'schedule' ? (
                <DateTimePicker
                  value={publishInput}
                  onChange={setPublishInput}
                  aria-label="定时发布时间"
                />
              ) : null}
            </div>
            <div className="space-y-2">
              <span className="text-xs font-medium">到期下线</span>
              <DateTimePicker value={expireInput} onChange={setExpireInput} aria-label="到期时间" />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  const base = localInputToEpoch(publishInput) ?? Date.now()
                  setExpireInput(epochToLocalInput(base + 30 * 86_400_000))
                }}
              >
                30 天后
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <span className="text-xs font-medium">投放对象</span>
            <SegmentedControl
              label="投放对象"
              value={draft.audience}
              onChange={(audience) => patch({ audience: audience as AnnouncementAudience })}
              options={(Object.keys(AUDIENCE_LABEL) as AnnouncementAudience[]).map((audience) => ({
                value: audience,
                label: AUDIENCE_LABEL[audience],
              }))}
            />
            <p className="text-xs text-muted-foreground">
              {draft.audience === 'anonymous'
                ? '未登录访客。付费 / 免费投放还没接上订阅状态。'
                : '付费 / 免费投放还没接上订阅状态。'}
            </p>
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <p className="text-xs text-muted-foreground">重要公告只弹一次。普通公告出现在更新页。</p>
        </form>

        <aside className="overflow-hidden rounded-xl border bg-card">
          <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
            <span className="mr-auto text-xs font-medium">实时预览 · 主站</span>
            <SegmentedControl
              label="预览形态"
              value={previewMode}
              onChange={(mode) => setPreviewMode(mode as 'list' | 'modal')}
              options={[
                { value: 'list', label: '更新页' },
                { value: 'modal', label: '弹窗' },
              ]}
            />
            <SegmentedControl
              label="预览主题"
              value={previewTheme}
              onChange={(theme) => setPreviewTheme(theme as 'dark' | 'light')}
              options={[
                { value: 'dark', label: '暗' },
                { value: 'light', label: '亮' },
              ]}
            />
            <SegmentedControl
              label="预览语言"
              value={previewLocale}
              onChange={(locale) => setPreviewLocale(locale as AnnouncementLocale)}
              options={[
                { value: 'zh', label: '中' },
                { value: 'en', label: 'EN' },
              ]}
            />
          </div>
          <AnnouncementPreview
            draft={currentDraft}
            locale={previewLocale}
            theme={previewTheme}
            mode={previewMode}
            coverUrl={coverUrl}
          />
        </aside>
      </div>

      <ReasonDialog
        open={action !== null}
        title={action === 'archive' ? '归档公告' : action === 'unpublish' ? '撤回公告' : '发布公告'}
        description="原因会写进审计记录。"
        confirmLabel={
          action === 'archive' ? '确认归档' : action === 'unpublish' ? '确认撤回' : '确认发布'
        }
        destructive={action === 'archive'}
        pending={
          mutations.publish.isPending ||
          mutations.unpublish.isPending ||
          mutations.archive.isPending
        }
        onOpenChange={(open) => {
          if (!open) setAction(null)
        }}
        onConfirm={(reason) => {
          void (async () => {
            const target = await persist(true)
            if (!target || !action) return
            try {
              if (action === 'publish') {
                const publishAt =
                  publishMode === 'schedule' ? localInputToEpoch(publishInput) : Date.now()
                await mutations.publish.mutateAsync({ id: target, reason, publishAt })
              } else if (action === 'unpublish') {
                await mutations.unpublish.mutateAsync({ id: target, reason })
              } else {
                await mutations.archive.mutateAsync({ id: target, reason })
              }
              setAction(null)
            } catch (actionError) {
              setError(announcementErrorMessage(actionError))
            }
          })()
        }}
      />
    </Page>
  )
}

function normalizeDraft(
  draft: AnnouncementDraft,
  publishMode: PublishMode,
  publishInput: string,
  expireInput: string,
): AnnouncementDraft {
  return {
    ...draft,
    titleZh: draft.titleZh.trim(),
    bodyZh: draft.bodyZh,
    titleEn: draft.titleEn?.trim() || null,
    bodyEn: draft.bodyEn?.trim() || null,
    ctaLabel: draft.ctaLabel?.trim() || null,
    ctaUrl: draft.ctaUrl?.trim() || null,
    versionTag: draft.versionTag?.trim() || null,
    coverKey: draft.coverKey?.trim() || null,
    publishAt: publishMode === 'schedule' ? localInputToEpoch(publishInput) : null,
    expireAt: localInputToEpoch(expireInput),
  }
}
