import * as Y from 'yjs'

export interface CanvasTextRun {
  insert: string | { divider: true }
  attributes?: {
    bold?: boolean
    italic?: boolean
    header?: 1 | 2 | 3
    list?: 'bullet' | 'ordered'
    indent?: number
  }
}

export function canvasText(doc: Y.Doc, id: string): Y.Text | undefined {
  const node = doc.getMap<Y.Map<unknown>>('nodes').get(id)
  const text = node?.get('richText')
  return node?.get('type') === 'text' && text instanceof Y.Text ? text : undefined
}

/** The terminal newline belongs to the editor. Dividers occupy one newline in the plain read model. */
export function plainCanvasText(text: Y.Text): string {
  const value = text
    .toDelta()
    .map((run: CanvasTextRun) => (typeof run.insert === 'string' ? run.insert : '\n'))
    .join('')
  return value.endsWith('\n') ? value.slice(0, -1) : value
}

export function initializeNodeText(node: Y.Map<unknown>, delta?: CanvasTextRun[]): boolean {
  if (node.get('type') !== 'text' || node.has('richText')) return false
  const data = node.get('data') as { text?: string }
  const text = new Y.Text()
  node.set('richText', text)
  if (delta) text.applyDelta(delta)
  else text.insert(0, `${data.text ?? ''}\n`)
  return true
}

/** Called under the persistence lock, before older documents reach editing clients. */
export function initializeCanvasTexts(doc: Y.Doc): boolean {
  let changed = false
  doc.transact(() => {
    for (const node of doc.getMap<Y.Map<unknown>>('nodes').values())
      changed = initializeNodeText(node) || changed
  }, 'system:rich-text-migration')
  return changed
}

/** Plain-text callers edit only the changed span, retaining unaffected rich formatting. */
export function replaceCanvasText(text: Y.Text, next: string): void {
  const current = plainCanvasText(text)
  if (next === current) return
  let start = 0
  while (start < current.length && start < next.length && current[start] === next[start]) start++
  // Y.Text offsets are UTF-16, but splitting a surrogate pair corrupts its content.
  if (start > 0 && /[\uDC00-\uDFFF]/.test(current[start] ?? '')) start--
  let end = 0
  while (
    end < current.length - start &&
    end < next.length - start &&
    current[current.length - 1 - end] === next[next.length - 1 - end]
  )
    end++
  if (end > 0 && /[\uDC00-\uDFFF]/.test(current[current.length - end] ?? '')) end--
  text.delete(start, current.length - start - end)
  text.insert(start, next.slice(start, next.length - end))
}

export function isCanvasTextDelta(value: unknown): value is CanvasTextRun[] {
  if (!Array.isArray(value) || value.length > 10000) return false
  return value.every((run) => {
    if (
      !run ||
      typeof run !== 'object' ||
      Object.keys(run).some((key) => !['insert', 'attributes'].includes(key))
    )
      return false
    if (
      typeof run.insert !== 'string' &&
      !(
        run.insert &&
        typeof run.insert === 'object' &&
        run.insert.divider === true &&
        Object.keys(run.insert).length === 1
      )
    )
      return false
    if (run.attributes === undefined) return true
    if (!run.attributes || typeof run.attributes !== 'object' || Array.isArray(run.attributes))
      return false
    return Object.entries(run.attributes).every(([key, attr]) => {
      if (key === 'bold' || key === 'italic') return typeof attr === 'boolean'
      if (key === 'header') return attr === 1 || attr === 2 || attr === 3
      if (key === 'list') return attr === 'bullet' || attr === 'ordered'
      return key === 'indent' && Number.isInteger(attr) && Number(attr) >= 0 && Number(attr) <= 8
    })
  })
}
