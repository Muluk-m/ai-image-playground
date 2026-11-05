import { describe, expect, it } from 'bun:test'
import {
  announcementExportDocument,
  announcementIsVisible,
  announcementMatchesAudience,
  applyLocalAnnouncementReads,
  effectiveAnnouncementStatus,
  isInSitePath,
  localizeAnnouncement,
  parseAnnouncementExport,
  parseAnnouncementMarkdown,
  selectMajorAnnouncement,
} from '../announcements'

const now = Date.parse('2026-11-05T02:00:00.000Z')

describe('effectiveAnnouncementStatus', () => {
  it('keeps drafts and archives out of the public window', () => {
    expect(
      announcementIsVisible({ status: 'draft', publishAt: now - 1000, expireAt: null }, now),
    ).toBe(false)
    expect(
      announcementIsVisible({ status: 'archived', publishAt: now - 1000, expireAt: null }, now),
    ).toBe(false)
  })

  it('hides a schedule until publish_at and hides it again after expire_at', () => {
    const scheduled = {
      status: 'scheduled' as const,
      publishAt: now + 60_000,
      expireAt: now + 86_400_000,
    }
    expect(effectiveAnnouncementStatus(scheduled, now)).toBe('scheduled')
    expect(announcementIsVisible(scheduled, now)).toBe(false)
    expect(effectiveAnnouncementStatus(scheduled, now + 60_000)).toBe('published')
    expect(announcementIsVisible(scheduled, now + 120_000)).toBe(true)
    expect(effectiveAnnouncementStatus(scheduled, now + 86_400_000)).toBe('archived')
    expect(
      announcementIsVisible({ status: 'published', publishAt: now - 1000, expireAt: now }, now),
    ).toBe(false)
  })
})

describe('audience and locale', () => {
  it('filters logged-in and anonymous audiences', () => {
    expect(announcementMatchesAudience('all', 'anonymous')).toBe(true)
    expect(announcementMatchesAudience('all', 'logged_in')).toBe(true)
    expect(announcementMatchesAudience('logged_in', 'anonymous')).toBe(false)
    expect(announcementMatchesAudience('logged_in', 'logged_in')).toBe(true)
    expect(announcementMatchesAudience('anonymous', 'logged_in')).toBe(false)
    expect(announcementMatchesAudience('anonymous', 'anonymous')).toBe(true)
  })

  it('falls back to Chinese when English copy is missing', () => {
    expect(
      localizeAnnouncement(
        { titleZh: '中文标题', bodyZh: '中文正文', titleEn: 'English', bodyEn: '' },
        'en',
      ),
    ).toEqual({ title: 'English', body: '中文正文', usedFallback: true })
    expect(
      localizeAnnouncement(
        { titleZh: '中文标题', bodyZh: '中文正文', titleEn: 'English', bodyEn: 'Body' },
        'en',
      ).usedFallback,
    ).toBe(false)
    expect(localizeAnnouncement({ titleZh: '中文标题', bodyZh: '中文正文' }, 'zh').title).toBe(
      '中文标题',
    )
  })
})

describe('in-site paths and export', () => {
  it('accepts only same-site paths', () => {
    expect(isInSitePath('/toolbox/remove-bg')).toBe(true)
    expect(isInSitePath('/changelog?from=drawer#top')).toBe(true)
    expect(isInSitePath('https://example.com/changelog')).toBe(false)
    expect(isInSitePath('//evil.example/changelog')).toBe(false)
    expect(isInSitePath('/\\windows')).toBe(false)
  })

  it('round-trips an export document and rejects a foreign shape', () => {
    const draft = {
      type: 'feature' as const,
      importance: 'normal' as const,
      titleZh: '去背景',
      bodyZh: '一次 20 张',
      titleEn: null,
      bodyEn: null,
      coverKey: null,
      ctaLabel: '打开',
      ctaUrl: '/toolbox/remove-bg',
      versionTag: 'v2.15.0',
      audience: 'all' as const,
      publishAt: null,
      expireAt: null,
    }
    expect(parseAnnouncementExport(announcementExportDocument(draft))).toEqual(draft)
    expect(parseAnnouncementExport({ format: 'other', version: 1, announcement: draft })).toBeNull()
    expect(
      parseAnnouncementExport(
        announcementExportDocument({ ...draft, ctaUrl: 'https://example.com' }),
      ),
    ).toBeNull()
  })
})

describe('reads and markdown', () => {
  it('picks a single unseen major announcement', () => {
    const items = [
      {
        id: 'old',
        importance: 'major' as const,
        publishAt: 1,
        unread: true,
        dismissed: false,
      },
      {
        id: 'new',
        importance: 'major' as const,
        publishAt: 2,
        unread: true,
        dismissed: false,
      },
      {
        id: 'seen',
        importance: 'major' as const,
        publishAt: 3,
        unread: false,
        dismissed: true,
      },
    ]
    expect(selectMajorAnnouncement(items)?.id).toBe('new')
    expect(selectMajorAnnouncement(items.slice(2))).toBeNull()
  })

  it('overlays anonymous local reads without touching signed-in flags', () => {
    const items = [
      {
        id: 'a',
        importance: 'normal' as const,
        publishAt: 1,
        unread: true,
        dismissed: false,
      },
    ]
    expect(
      applyLocalAnnouncementReads(items, { a: { readAt: 1, dismissedAt: 2 } }, true)[0],
    ).toMatchObject({ unread: false, dismissed: true })
    expect(applyLocalAnnouncementReads(items, { a: { readAt: 1 } }, false)[0]?.unread).toBe(true)
  })

  it('parses the small markdown subset and drops external links', () => {
    const blocks = parseAnnouncementMarkdown(
      '## 标题\n\n一次处理 **20** 张。\n\n- 去 [工具箱](/toolbox/remove-bg)\n- 见 [外站](https://example.com)\n',
    )
    expect(blocks.map((block) => block.type)).toEqual(['heading', 'paragraph', 'list'])
    expect(blocks[1]).toMatchObject({
      inlines: [
        { type: 'text', text: '一次处理 ' },
        { type: 'strong', text: '20' },
        { type: 'text', text: ' 张。' },
      ],
    })
    expect(blocks[2]).toMatchObject({
      items: [
        [
          { type: 'text', text: '去 ' },
          { type: 'link', href: '/toolbox/remove-bg' },
        ],
        [
          { type: 'text', text: '见 ' },
          { type: 'text', text: '外站' },
        ],
      ],
    })
  })

  it('treats numbered lines as list items and drops the source numbers', () => {
    const blocks = parseAnnouncementMarkdown('1. 粗剪\n2. 字幕\n\n不是列表')
    expect(blocks).toMatchObject([
      {
        type: 'list',
        items: [[{ type: 'text', text: '粗剪' }], [{ type: 'text', text: '字幕' }]],
      },
      { type: 'paragraph', inlines: [{ type: 'text', text: '不是列表' }] },
    ])
  })
})
