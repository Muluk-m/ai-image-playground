import { Fragment, useEffect, useRef, useState } from 'react'
import { Button } from '../../../web/src/components/ui/button'
import { Icon } from '../../../web/src/components/ui/icon'
import { Input } from '../../../web/src/components/ui/input'
import {
  type Block,
  type GuideContent,
  type GuideFaq,
  guideEntries,
  type ShotBlock,
  type VideoBlock,
} from '../../../web/src/features/guide/model'
import { copyTextToClipboard } from '../../../web/src/lib/clipboardText'
import { copy, editions, type Locale, type SitePage } from '../catalog'
import { readingMinutes, searchGuide } from '../guideData'

function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*.+?\*\*|\[\[.+?\]\]|\{\{.+?\}\}|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g)
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('**'))
          return (
            <strong key={i}>
              <Inline text={part.slice(2, -2)} />
            </strong>
          )
        if (part.startsWith('[['))
          return (
            <span className="guide-ui" key={i}>
              {part.slice(2, -2)}
            </span>
          )
        if (part.startsWith('{{')) return <kbd key={i}>{part.slice(2, -2)}</kbd>
        if (part.startsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>
        const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
        if (link && /^(\/(?!\/)|#|https:\/\/|mailto:)/.test(link[2]!))
          return (
            <a href={link[2]} key={i}>
              {link[1]}
            </a>
          )
        return <Fragment key={i}>{part}</Fragment>
      })}
    </>
  )
}
function Shot({ block }: { block: ShotBlock }) {
  return (
    <figure
      className="guide-figure"
      style={block.width ? { width: block.width, maxWidth: '100%' } : undefined}
    >
      <div className="guide-shot">
        <img
          {...(typeof __GUIDE_IMAGE_SIZES__ === 'undefined'
            ? {}
            : __GUIDE_IMAGE_SIZES__[block.src])}
          src={block.src}
          alt={block.alt}
          loading="lazy"
        />
        {block.marks?.map((mark, i) => (
          <span aria-hidden="true" key={i} style={{ left: `${mark.x}%`, top: `${mark.y}%` }}>
            {mark.label ?? i + 1}
          </span>
        ))}
      </div>
      {block.caption ? (
        <figcaption>
          <Inline text={block.caption} />
        </figcaption>
      ) : null}
    </figure>
  )
}
/**
 * 录屏：静态 HTML 里带播放控件与封面（没有脚本也能手动播放）；脚本接管后去掉控件，
 * 进入视口才加载并静音循环播放，离开即暂停。系统要求减少动态效果时保持手动播放。
 */
function Video({ block }: { block: VideoBlock }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const video = ref.current
    if (!video || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    video.muted = true
    video.controls = false
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          video.preload = 'auto'
          video.play().catch(() => {
            video.controls = true
          })
        } else video.pause()
      },
      { threshold: 0.4 },
    )
    observer.observe(video)
    return () => observer.disconnect()
  }, [])
  return (
    <figure className="guide-figure" style={{ width: block.width, maxWidth: '100%' }}>
      <div className="guide-shot">
        <video
          ref={ref}
          width={block.width}
          height={block.height}
          poster={block.poster}
          aria-label={block.alt}
          controls
          muted
          loop
          playsInline
          preload="none"
        >
          {block.webm ? <source src={block.webm} type="video/webm" /> : null}
          <source src={block.src} type="video/mp4" />
        </video>
      </div>
      {block.caption ? (
        <figcaption>
          <Inline text={block.caption} />
        </figcaption>
      ) : null}
    </figure>
  )
}
function GuideBlock({
  block,
  guide,
  locale,
}: {
  block: Block
  guide: GuideContent
  locale: Locale
}) {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  switch (block.type) {
    case 'p':
      return (
        <p>
          <Inline text={block.text} />
        </p>
      )
    case 'steps': {
      const list = (
        <ol className="guide-steps">
          {block.items.map((item, i) => (
            <li key={i}>
              <span>
                <Inline text={item} />
              </span>
            </li>
          ))}
        </ol>
      )
      if (!block.shot) return list
      return (
        <div className={block.shot.width ? 'guide-split' : 'guide-procedure'}>
          {list}
          <Shot block={block.shot} />
        </div>
      )
    }
    case 'list':
      return (
        <ul>
          {block.items.map((item, i) => (
            <li key={i}>
              <Inline text={item} />
            </li>
          ))}
        </ul>
      )
    case 'callout':
      return (
        <aside className={`guide-callout guide-callout-${block.tone}`}>
          <strong>
            {block.tone === 'tip'
              ? guide.chrome.tipLabel
              : block.tone === 'warn'
                ? guide.chrome.warnLabel
                : guide.chrome.noteLabel}
          </strong>
          <span>
            <Inline text={block.text} />
          </span>
        </aside>
      )
    case 'table':
      return (
        <div className="guide-table">
          <table>
            <thead>
              <tr>
                {block.head.map((item, i) => (
                  <th key={i}>
                    <Inline text={item} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((item, j) => (
                    <td key={j}>
                      <Inline text={item} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'shot':
      return <Shot block={block} />
    case 'video':
      return <Video block={block} />
    case 'faq':
      return <Faq items={block.items} />
    case 'prompt':
      return (
        <section className="guide-prompt">
          <strong>
            <Inline text={block.label} />
          </strong>
          <pre>{block.text}</pre>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              try {
                await copyTextToClipboard(block.text)
                setCopyStatus('copied')
              } catch {
                setCopyStatus('failed')
              }
            }}
          >
            {copyStatus === 'copied' ? copy[locale].copied : copy[locale].copy}
          </Button>
          {copyStatus === 'failed' ? <p role="status">{copy[locale].copyFailed}</p> : null}
        </section>
      )
  }
}
function Faq({ items }: { items: GuideFaq[] }) {
  return (
    <div className="guide-faq">
      {items.map((item) => (
        <details key={item.q}>
          <summary>{item.q}</summary>
          <p>{item.a}</p>
        </details>
      ))}
    </div>
  )
}
/** 旧地址的锚点 → 新地址；没有登记的锚点原样带到新页面。只在静态 HTML 首次解析时执行。 */
function redirectScript(guide: GuideContent, from: string, to: string | null) {
  const anchors = Object.fromEntries(
    Object.entries(guide.moved[from]?.anchors ?? {}).map(([id, target]) => [
      id,
      guide.root + target,
    ]),
  )
  return `(function(){var a=${JSON.stringify(anchors)},h=location.hash.slice(1),t=a[h]${
    to ? `||${JSON.stringify(to)}+location.hash` : ''
  };if(t)location.replace(t)})()`
}
export function GuideMovedPage({ page }: { page: SitePage }) {
  const guide = editions[page.locale]
  return (
    <main className="guide-moved">
      <h1>{guide.chrome.movedTitle}</h1>
      <p>
        {guide.chrome.movedBody} <a href={page.movedTo}>{page.movedTo}</a>
      </p>
      <script
        dangerouslySetInnerHTML={{
          __html: redirectScript(guide, page.movedFrom ?? '', page.movedTo ?? null),
        }}
      />
    </main>
  )
}
/** 右侧「本页内容」随滚动高亮当前小节。 */
function useActiveSection(ids: string[]) {
  const [active, setActive] = useState(ids[0])
  const key = ids.join(' ')
  useEffect(() => {
    const targets = key
      .split(' ')
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => !!el)
    if (!targets.length) return
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting)
        if (visible.length) setActive(visible[0]!.target.id)
      },
      { rootMargin: '0px 0px -70% 0px' },
    )
    for (const target of targets) observer.observe(target)
    return () => observer.disconnect()
  }, [key])
  return active
}
export function Guide({ page }: { page: SitePage }) {
  const guide = editions[page.locale],
    text = copy[page.locale]
  const entries = guideEntries(guide)
  const index = entries.findIndex((entry) => entry.key === page.guideKey)
  const entry = entries[index]
  const [query, setQuery] = useState('')
  const normalized = query.trim().toLocaleLowerCase()
  const results = searchGuide(guide, query)
  const sections = entry?.page.sections ?? []
  const active = useActiveSection(sections.map((section) => section.id))
  const prev = index > 0 ? entries[index - 1] : undefined
  const next = index >= 0 ? entries[index + 1] : undefined
  const related = (entry?.page.related ?? [])
    .map((key) => entries.find((item) => item.key === key))
    .filter((item) => !!item)
  return (
    <main className="guide-layout">
      <aside className="guide-sidebar" id="guide-nav">
        <Input
          type="search"
          aria-label={guide.chrome.search}
          placeholder={guide.chrome.search}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {normalized ? (
          <div className="guide-results" aria-live="polite">
            {results.length ? (
              results.map((item) => (
                <a key={`${item.path}:${item.title}`} href={item.path}>
                  {item.title}
                </a>
              ))
            ) : (
              <p>{guide.chrome.searchEmpty}</p>
            )}
          </div>
        ) : (
          <nav className="guide-tree" aria-label={guide.chrome.toc}>
            <a href={guide.root} aria-current={entry ? undefined : 'page'}>
              {guide.chrome.title}
            </a>
            {guide.groups.map((group) => (
              <details key={group.id} open={!entry || entry.group === group}>
                <summary>
                  {group.title}
                  <Icon name="chevronDown" />
                </summary>
                {entries
                  .filter((item) => item.group === group)
                  .map((item) => (
                    <a
                      key={item.key}
                      href={item.path}
                      aria-current={item.key === entry?.key ? 'page' : undefined}
                    >
                      {item.page.title}
                    </a>
                  ))}
              </details>
            ))}
          </nav>
        )}
      </aside>
      <article className="guide-body">
        <nav className="guide-breadcrumb" aria-label={text.guide}>
          <a href={guide.root}>{guide.chrome.title}</a>
          {entry ? (
            <>
              <Icon name="chevronRight" />
              <span>{entry.group.title}</span>
              <Icon name="chevronRight" />
              <span aria-current="page">{entry.page.title}</span>
            </>
          ) : null}
          <a className="guide-menu-link" href="#guide-nav">
            <Icon name="list" />
            {guide.chrome.toc}
          </a>
        </nav>
        <h1>{entry?.page.title ?? guide.chrome.title}</h1>
        {entry ? (
          <p className="guide-meta">
            {guide.chrome.readingTime.replace('{n}', String(readingMinutes(guide, entry.page)))}
            <span aria-hidden="true">·</span>
            {guide.chrome.updated} <time dateTime={entry.page.updated}>{entry.page.updated}</time>
          </p>
        ) : null}
        <p className="guide-lead">{entry?.page.summary ?? guide.chrome.lead}</p>
        {entry ? (
          <>
            {entry.page.intro?.map((block, i) => (
              <GuideBlock key={i} block={block} guide={guide} locale={page.locale} />
            ))}
            {sections.map((section) => (
              <section id={section.id} className="guide-section" key={section.id}>
                <h2>{section.title}</h2>
                {section.blocks.map((block, i) => (
                  <GuideBlock block={block} guide={guide} locale={page.locale} key={i} />
                ))}
              </section>
            ))}
            {related.length ? (
              <section className="guide-section guide-related">
                <h2>{guide.chrome.related}</h2>
                <div>
                  {related.map((item) => (
                    <a key={item.key} href={item.path}>
                      <strong>{item.page.title}</strong>
                      <span>{item.page.summary}</span>
                    </a>
                  ))}
                </div>
              </section>
            ) : null}
            <nav
              className="guide-pagination"
              aria-label={`${guide.chrome.prev} / ${guide.chrome.next}`}
            >
              {prev ? (
                <a href={prev.path}>
                  <small>{guide.chrome.prev}</small>
                  {prev.page.title}
                </a>
              ) : (
                <span />
              )}
              {next ? (
                <a href={next.path} className="guide-next">
                  <small>{guide.chrome.next}</small>
                  {next.page.title}
                </a>
              ) : null}
            </nav>
          </>
        ) : (
          <div id="chapters" className="guide-groups">
            {guide.groups.map((group) => (
              <section key={group.id}>
                <h2>{group.title}</h2>
                {entries
                  .filter((item) => item.group === group)
                  .map((item) => (
                    <a key={item.key} href={item.path}>
                      <strong>{item.page.title}</strong>
                      <span>{item.page.summary}</span>
                    </a>
                  ))}
              </section>
            ))}
            {guide.moved['']?.anchors ? (
              <script dangerouslySetInnerHTML={{ __html: redirectScript(guide, '', null) }} />
            ) : null}
          </div>
        )}
      </article>
      {sections.length ? (
        <nav className="guide-toc" aria-label={guide.chrome.onThisPage}>
          <strong>{guide.chrome.onThisPage}</strong>
          {sections.map((section) => (
            <a
              key={section.id}
              href={`#${section.id}`}
              aria-current={section.id === active ? 'location' : undefined}
            >
              {section.title}
            </a>
          ))}
        </nav>
      ) : null}
    </main>
  )
}
