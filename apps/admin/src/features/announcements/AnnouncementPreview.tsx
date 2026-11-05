import type { AnnouncementDraft, AnnouncementLocale } from '@image-playground/shared'
import { localizeAnnouncement, parseAnnouncementMarkdown } from '@image-playground/shared'
import { TYPE_LABEL } from '@/lib/announcements'

/**
 * 编辑器右侧的主站预览。颜色取自 apps/web/DESIGN.md，不跟后台的浅色壳走，
 * 这样亮/暗开关能单独预览用户真正会看到的那一面。
 */
const THEME = {
  dark: {
    background: '#111311',
    surface: '#181b18',
    foreground: '#f6f6f4',
    muted: '#a6a9a2',
    primary: '#c1eb94',
    onPrimary: '#161f14',
    border: '#323531',
  },
  light: {
    background: '#f8f8f7',
    surface: '#ffffff',
    foreground: '#1d201d',
    muted: '#6c7269',
    primary: '#436c28',
    onPrimary: '#ffffff',
    border: '#d9dbd6',
  },
} as const

export function AnnouncementPreview({
  draft,
  locale,
  theme,
  mode,
  coverUrl,
}: {
  draft: AnnouncementDraft
  locale: AnnouncementLocale
  theme: 'dark' | 'light'
  mode: 'list' | 'modal'
  coverUrl: string | null
}) {
  const colors = THEME[theme]
  const copy = localizeAnnouncement(draft, locale)
  const blocks = parseAnnouncementMarkdown(copy.body)
  const when = draft.publishAt
    ? new Intl.DateTimeFormat(locale === 'en' ? 'en' : 'zh-CN', {
        month: 'numeric',
        day: 'numeric',
      }).format(new Date(draft.publishAt))
    : ''
  const meta = [draft.versionTag, when].filter(Boolean).join(' · ')

  const body = (
    <div className="space-y-2 text-[13px] leading-relaxed" style={{ color: colors.foreground }}>
      {blocks.length === 0 ? (
        <p style={{ color: colors.muted }}>正文</p>
      ) : (
        blocks.map((block, index) => {
          if (block.type === 'list') {
            return (
              <ul key={index} className="list-disc space-y-1 pl-4">
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>{item.map((inline) => inline.text).join('')}</li>
                ))}
              </ul>
            )
          }
          const text = block.inlines.map((inline) => inline.text).join('')
          if (block.type === 'heading')
            return (
              <p key={index} className="font-medium">
                {text}
              </p>
            )
          return <p key={index}>{text}</p>
        })
      )}
    </div>
  )

  const cover = coverUrl ? (
    <img src={coverUrl} alt="" className="aspect-video w-full rounded-lg object-cover" />
  ) : (
    <div
      className="grid aspect-video place-items-center rounded-lg text-xs"
      style={{ background: theme === 'dark' ? '#1c241c' : '#e7efe4', color: colors.muted }}
    >
      封面占位 · 1600×900
    </div>
  )

  if (mode === 'modal') {
    return (
      <div className="grid min-h-[520px] place-items-center p-6" style={{ background: '#070807' }}>
        <div
          className="w-full max-w-md overflow-hidden rounded-2xl border p-4 shadow-lg"
          style={{
            background: colors.surface,
            color: colors.foreground,
            borderColor: colors.border,
          }}
        >
          {cover}
          <p className="mt-3 text-xs" style={{ color: colors.primary }}>
            {TYPE_LABEL[draft.type]}
            {meta ? ` · ${meta}` : ''}
          </p>
          <h3 className="mt-1 text-base font-semibold">{copy.title || '标题'}</h3>
          <div className="mt-2">{body}</div>
          <div className="mt-4 flex items-center justify-end gap-2">
            <span
              className="inline-flex h-9 items-center rounded-md border px-3 text-sm"
              style={{ borderColor: colors.border, color: colors.muted }}
            >
              稍后再看
            </span>
            {draft.ctaLabel ? (
              <span
                className="inline-flex h-9 items-center rounded-md px-3 text-sm font-medium"
                style={{ background: colors.primary, color: colors.onPrimary }}
              >
                {draft.ctaLabel}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className="min-h-[520px] p-4"
      style={{ background: colors.background, color: colors.foreground }}
    >
      <div
        className="mx-auto max-w-sm overflow-hidden rounded-xl border"
        style={{ background: colors.surface, borderColor: colors.border }}
      >
        <div
          className="flex items-center justify-between border-b px-3 py-2 text-sm"
          style={{ borderColor: colors.border }}
        >
          <span className="font-medium">更新</span>
          <span className="text-xs" style={{ color: colors.muted }}>
            全部标为已读
          </span>
        </div>
        <div className="space-y-3 p-3">
          {cover}
          <p className="text-xs" style={{ color: colors.primary }}>
            {TYPE_LABEL[draft.type]}
            {meta ? ` · ${meta}` : ''}
          </p>
          <h3 className="text-sm font-semibold">{copy.title || '标题'}</h3>
          {body}
          {draft.ctaLabel ? (
            <p className="text-sm" style={{ color: colors.primary }}>
              {draft.ctaLabel} →
            </p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
