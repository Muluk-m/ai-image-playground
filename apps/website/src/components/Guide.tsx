import { Fragment, useState } from 'react'
import { Button } from '../../../web/src/components/ui/button'
import { Input } from '../../../web/src/components/ui/input'
import type { Block, GuideFaq } from '../../../web/src/features/guide/model'
import { copy, editions, type Locale, type SitePage } from '../catalog'
import { searchGuide } from '../guideData'

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
        if (link && /^(\/(?!\/)|#|https:\/\/)/.test(link[2]!))
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
function GuideBlock({ block, locale }: { block: Block; locale: Locale }) {
  const [copied, setCopied] = useState(false)
  switch (block.type) {
    case 'p':
      return (
        <p>
          <Inline text={block.text} />
        </p>
      )
    case 'steps':
      return (
        <ol>
          {block.items.map((item, i) => (
            <li key={i}>
              <Inline text={item} />
            </li>
          ))}
        </ol>
      )
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
          <Inline text={block.text} />
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
      return (
        <figure>
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
              <span key={i} style={{ left: `${mark.x}%`, top: `${mark.y}%` }}>
                {i + 1}
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
            onClick={() =>
              void navigator.clipboard
                .writeText(block.text)
                .then(() => setCopied(true))
                .catch(() => setCopied(false))
            }
          >
            {copied ? copy[locale].copied : copy[locale].copy}
          </Button>
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
export function Guide({ page }: { page: SitePage }) {
  const guide = editions[page.locale],
    text = copy[page.locale]
  const chapter = guide.chapters.find((c) => c.id === page.chapterId)
  const [query, setQuery] = useState('')
  const normalized = query.trim().toLocaleLowerCase()
  const results = searchGuide(guide, query)
  const index = chapter ? guide.chapters.indexOf(chapter) : -1
  return (
    <main className="guide-layout">
      <aside className="guide-sidebar">
        <a className="guide-home-link" href={guide.root}>
          {text.guide}
        </a>
        <Input
          type="search"
          aria-label={text.search}
          placeholder={text.search}
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
              <p>{text.empty}</p>
            )}
          </div>
        ) : (
          <nav aria-label={guide.chrome.toc}>
            {guide.chapters.map((c) => (
              <a
                key={c.id}
                href={`${guide.root}${c.id}/`}
                aria-current={c.id === chapter?.id ? 'page' : undefined}
              >
                {c.title}
              </a>
            ))}
          </nav>
        )}
      </aside>
      <article className="guide-body">
        <nav className="guide-breadcrumb" aria-label={guide.chrome.toc}>
          <a href={page.locale === 'en' ? '/en/' : '/'}>{text.brand}</a>
          <span>/</span>
          <a href={guide.root}>{text.guide}</a>
          {chapter ? (
            <>
              <span>/</span>
              <span>{chapter.title}</span>
            </>
          ) : null}
        </nav>
        <h1>{chapter?.title ?? guide.chrome.title}</h1>
        <p className="guide-lead">{chapter?.summary ?? guide.chrome.lead}</p>
        {chapter ? (
          <>
            {chapter.intro?.map((block, i) => (
              <GuideBlock key={i} block={block} locale={page.locale} />
            ))}
            <nav className="guide-on-page" aria-label={guide.chrome.onThisPage}>
              {chapter.subsections.map((section) => (
                <a key={section.id} href={`#${section.id}`}>
                  {section.title}
                </a>
              ))}
            </nav>
            {chapter.subsections.map((section) => (
              <section id={section.id} className="guide-section" key={section.id}>
                <h2>{section.title}</h2>
                {section.blocks.map((block, i) => (
                  <GuideBlock block={block} locale={page.locale} key={i} />
                ))}
              </section>
            ))}
            {chapter.faq ? (
              <section id="faq">
                <Faq items={chapter.faq} />
              </section>
            ) : null}
            <nav className="guide-pagination">
              {index > 0 ? (
                <a href={`${guide.root}${guide.chapters[index - 1]!.id}/`}>
                  ← {guide.chapters[index - 1]!.title}
                </a>
              ) : (
                <span />
              )}
              {index < guide.chapters.length - 1 ? (
                <a href={`${guide.root}${guide.chapters[index + 1]!.id}/`}>
                  {guide.chapters[index + 1]!.title} →
                </a>
              ) : null}
            </nav>
          </>
        ) : (
          <>
            <div id="chapters" className="guide-chapters">
              {guide.chapters.map((chapter, i) => (
                <a key={chapter.id} href={`${guide.root}${chapter.id}/`}>
                  <small>{String(i + 1).padStart(2, '0')}</small>
                  <h2>{chapter.title}</h2>
                  <p>{chapter.summary}</p>
                </a>
              ))}
            </div>
            <section id={guide.faq.id}>
              <h2>{guide.faq.title}</h2>
              <Faq items={guide.faq.items} />
            </section>
          </>
        )}
      </article>
    </main>
  )
}
