import type { CanvasTextRun, TextNodeData } from '@image-playground/shared'
import { Fragment, type ReactNode } from 'react'

export default function NodeTextContent({ data }: { data: TextNodeData }) {
  if (!data.richText) return <>{data.text}</>
  const blocks: ReactNode[] = []
  let inline: ReactNode[] = []
  let ordered = 0
  const line = (attributes: CanvasTextRun['attributes'] = {}) => {
    const content = inline.length ? inline : <br />
    inline = []
    const key = blocks.length
    if (attributes.list) {
      ordered = attributes.list === 'ordered' ? ordered + 1 : 0
      const List = attributes.list === 'ordered' ? 'ol' : 'ul'
      blocks.push(
        <List
          key={key}
          start={ordered || undefined}
          style={{ marginLeft: `${(attributes.indent ?? 0) * 1.5}em` }}
        >
          <li>{content}</li>
        </List>,
      )
    } else {
      ordered = 0
      const Tag =
        attributes.header === 1
          ? 'h1'
          : attributes.header === 2
            ? 'h2'
            : attributes.header === 3
              ? 'h3'
              : 'p'
      blocks.push(<Tag key={key}>{content}</Tag>)
    }
  }
  for (const run of data.richText) {
    if (typeof run.insert !== 'string') {
      if (inline.length) line()
      blocks.push(<hr key={blocks.length} />)
      continue
    }
    const parts = run.insert.split('\n')
    parts.forEach((part, index) => {
      if (part) {
        let content: ReactNode = part
        if (run.attributes?.bold) content = <strong>{content}</strong>
        if (run.attributes?.italic) content = <em>{content}</em>
        inline.push(<Fragment key={inline.length}>{content}</Fragment>)
      }
      if (index < parts.length - 1) line(run.attributes)
    })
  }
  if (inline.length) line()
  return <div className="studio-node-rich-content">{blocks}</div>
}
