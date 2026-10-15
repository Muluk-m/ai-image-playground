import { canvasText } from '@image-playground/shared'
import Quill from 'quill'
import { BlockEmbed } from 'quill/blots/block'
import { useEffect, useRef, useState } from 'react'
import { QuillBinding } from 'y-quill'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import type { NodeCanvasDocument } from '../lib/nodeCanvasDocument'
import 'quill/dist/quill.core.css'

class Divider extends BlockEmbed {
  static blotName = 'divider'
  static tagName = 'hr'
  static value() {
    return true
  }
}
Quill.register(Divider, true)

export default function NodeTextEditor({
  canvas,
  nodeId,
  onDone,
  onExpand,
}: {
  canvas: NodeCanvasDocument
  nodeId: string
  onDone: () => void
  onExpand?: () => void
}) {
  const { t } = useTranslation('canvas')
  const mount = useRef<HTMLDivElement>(null)
  const quill = useRef<Quill | null>(null)
  const [formats, setFormats] = useState<Record<string, unknown>>({})
  const [ready, setReady] = useState(false)
  const placeholder = t('nodes.textPlaceholder')
  useEffect(() => {
    const host = mount.current
    const text = canvasText(canvas.doc, nodeId)
    if (!host || !text) return
    const target = document.createElement('div')
    host.appendChild(target)
    const editor = new Quill(target, {
      formats: ['header', 'bold', 'italic', 'list', 'indent', 'divider'],
      modules: {
        toolbar: false,
        history: false,
        keyboard: {
          bindings: {
            undo: {
              key: 'z',
              shortKey: true,
              shiftKey: false,
              handler: () => {
                canvas.undo.undo()
                return false
              },
            },
            redo: {
              key: 'z',
              shortKey: true,
              shiftKey: true,
              handler: () => {
                canvas.undo.redo()
                return false
              },
            },
            redoWindows: {
              key: 'y',
              shortKey: true,
              handler: () => {
                canvas.undo.redo()
                return false
              },
            },
          },
        },
      },
      placeholder,
    })
    editor.root.setAttribute('role', 'textbox')
    editor.root.setAttribute('aria-label', t('nodes.composerText'))
    editor.root.setAttribute('aria-multiline', 'true')
    const binding = new QuillBinding(text, editor)
    canvas.undo.addTrackedOrigin(binding)
    canvas.undo.stopCapturing()
    const selection = () => setFormats(editor.getFormat())
    editor.on('selection-change', selection)
    editor.on('text-change', selection)
    quill.current = editor
    setReady(true)
    editor.focus()
    return () => {
      canvas.undo.stopCapturing()
      canvas.undo.removeTrackedOrigin(binding)
      binding.destroy()
      editor.off('selection-change', selection)
      editor.off('text-change', selection)
      quill.current = null
      host.replaceChildren()
    }
  }, [canvas, nodeId, placeholder, t])
  const format = (key: string, value: unknown) => {
    const editor = quill.current
    if (!editor) return
    canvas.undo.stopCapturing()
    editor.focus()
    editor.format(key, formats[key] === value ? false : value, 'user')
    setFormats(editor.getFormat())
    canvas.undo.stopCapturing()
  }
  const divider = () => {
    const editor = quill.current
    if (!editor) return
    canvas.undo.stopCapturing()
    const range = editor.getSelection(true)
    const at = range?.index ?? Math.max(0, editor.getLength() - 1)
    editor.insertEmbed(at, 'divider', true, 'user')
    editor.setSelection(at + 1, 0, 'silent')
    canvas.undo.stopCapturing()
  }
  return (
    <div
      className="studio-node-text-editor nodrag nopan nowheel"
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Escape' || (event.key === 'Enter' && (event.metaKey || event.ctrlKey))) {
          event.preventDefault()
          onDone()
        }
      }}
    >
      <div
        className="studio-node-text-format"
        role="toolbar"
        aria-label={t('nodes.textFormatting')}
      >
        {([1, 2, 3] as const).map((level) => (
          <Button
            key={level}
            variant="ghost"
            size="xs"
            disabled={!ready}
            aria-label={t('nodes.heading', { level })}
            aria-pressed={formats.header === level}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => format('header', level)}
          >
            H{level}
          </Button>
        ))}
        <Button
          variant="ghost"
          size="xs"
          disabled={!ready}
          aria-label={t('nodes.bold')}
          aria-pressed={Boolean(formats.bold)}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => format('bold', true)}
        >
          <strong>B</strong>
        </Button>
        <Button
          variant="ghost"
          size="xs"
          disabled={!ready}
          aria-label={t('nodes.italic')}
          aria-pressed={Boolean(formats.italic)}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => format('italic', true)}
        >
          <em>I</em>
        </Button>
        <Button
          variant="ghost"
          size="xs"
          disabled={!ready}
          aria-label={t('nodes.bulletList')}
          aria-pressed={formats.list === 'bullet'}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => format('list', 'bullet')}
        >
          •
        </Button>
        <Button
          variant="ghost"
          size="xs"
          disabled={!ready}
          aria-label={t('nodes.orderedList')}
          aria-pressed={formats.list === 'ordered'}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => format('list', 'ordered')}
        >
          1.
        </Button>
        <Button
          variant="ghost"
          size="xs"
          disabled={!ready}
          aria-label={t('nodes.divider')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={divider}
        >
          —
        </Button>
        {onExpand && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t('nodes.editFullscreen')}
            onClick={onExpand}
          >
            <Icon name="fullscreen" />
          </Button>
        )}
        <Button variant="ghost" size="xs" onClick={onDone}>
          {t('nodes.finishEditing')}
        </Button>
      </div>
      <div className="studio-node-quill" ref={mount} />
    </div>
  )
}
