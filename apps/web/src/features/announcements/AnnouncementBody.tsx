import type { AnnouncementInline } from '@image-playground/shared'
import { parseAnnouncementMarkdown } from '@image-playground/shared'
import { navigate } from '../../lib/pathname'

function InlineText({ inline }: { inline: AnnouncementInline }) {
  if (inline.type === 'strong') return <strong className="font-medium">{inline.text}</strong>
  if (inline.type === 'link') {
    return (
      <a
        href={inline.href}
        className="text-primary"
        onClick={(event) => {
          event.preventDefault()
          navigate(inline.href)
        }}
      >
        {inline.text}
      </a>
    )
  }
  return <>{inline.text}</>
}

export function AnnouncementBody({
  source,
  ordered = false,
}: {
  source: string
  /** 更新页按 LibTV 用序号；弹窗仍用圆点。 */
  ordered?: boolean
}) {
  const blocks = parseAnnouncementMarkdown(source)
  return (
    <div className="space-y-3 text-body-sm text-foreground">
      {blocks.map((block, index) => {
        if (block.type === 'list') {
          const items = block.items.map((item, itemIndex) => (
            <li key={itemIndex}>
              {item.map((inline, inlineIndex) => (
                <InlineText key={inlineIndex} inline={inline} />
              ))}
            </li>
          ))
          return ordered ? (
            <ol key={index} className="list-decimal space-y-3 pl-6">
              {items}
            </ol>
          ) : (
            <ul key={index} className="list-disc space-y-1 pl-4">
              {items}
            </ul>
          )
        }
        const content = block.inlines.map((inline, inlineIndex) => (
          <InlineText key={inlineIndex} inline={inline} />
        ))
        if (block.type === 'heading') {
          return (
            <p key={index} className="font-medium">
              {content}
            </p>
          )
        }
        return <p key={index}>{content}</p>
      })}
    </div>
  )
}
