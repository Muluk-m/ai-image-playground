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

export function AnnouncementBody({ source }: { source: string }) {
  const blocks = parseAnnouncementMarkdown(source)
  return (
    <div className="space-y-2 text-body-sm text-foreground">
      {blocks.map((block, index) => {
        if (block.type === 'list') {
          return (
            <ul key={index} className="list-disc space-y-1 pl-4 text-foreground">
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>
                  {item.map((inline, inlineIndex) => (
                    <InlineText key={inlineIndex} inline={inline} />
                  ))}
                </li>
              ))}
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
