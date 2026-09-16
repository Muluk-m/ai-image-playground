import { useEffect, useId, useRef, useState } from 'react'
import { BookmarkIcon, CloseIcon, CodeIcon, CopyIcon } from '../../../components/icons'
import Overlay from '../../../components/Overlay'
import { copyTextToClipboard, getClipboardFailureMessage } from '../../../lib/clipboard'
import { useStore } from '../../../store'
import { useLibraryStore } from '../../library/store'

export default function AgentPromptDialog({
  prompt,
  onClose,
}: {
  prompt: string
  onClose: () => void
}) {
  const titleId = useId()
  const saveRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const [copied, setCopied] = useState(false)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    return () => previous?.focus()
  }, [])
  const action =
    'inline-flex min-h-10 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
  return (
    <Overlay onClose={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[85dvh] w-full max-w-[780px] flex-col overflow-hidden rounded-2xl border border-border bg-card text-foreground shadow-2xl"
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return
          const items = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input, [tabindex="0"]',
            ),
          )
          const first = items[0],
            last = items[items.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last?.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first?.focus()
          }
        }}
      >
        <header className="flex shrink-0 items-center justify-between gap-2 px-4 py-3 sm:px-5">
          <h2 id={titleId} className="flex items-center gap-2 text-sm font-semibold">
            <CodeIcon aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
            提示词
          </h2>
          <button
            ref={closeRef}
            type="button"
            className={action}
            aria-label="关闭提示词"
            onClick={onClose}
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </header>
        <div className="mx-4 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background sm:mx-5">
          <div className="flex shrink-0 items-center justify-between border-b border-border bg-muted/40 px-3">
            <span className="font-mono text-[11px] text-muted-foreground">Plain text</span>
            <button
              type="button"
              className={action}
              onClick={() => {
                void copyTextToClipboard(prompt).then(
                  () => setCopied(true),
                  (error) =>
                    useStore
                      .getState()
                      .showToast(
                        getClipboardFailureMessage('复制失败，请选择正文手动复制', error),
                        'error',
                      ),
                )
              }}
            >
              <CopyIcon className="h-4 w-4" />
              {copied ? '已复制' : '复制'}
            </button>
          </div>
          <pre
            tabIndex={0}
            data-selectable-text
            aria-label="完整提示词"
            className="min-h-0 overflow-y-auto whitespace-pre-wrap break-words p-4 font-mono text-[13px] font-normal leading-[1.9] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:p-5 sm:text-sm sm:leading-[1.9]"
          >
            {prompt}
          </pre>
        </div>
        <footer className="flex shrink-0 items-center justify-between gap-2 px-4 py-2 sm:px-5">
          <span className="text-[11px] text-muted-foreground">
            {Array.from(prompt).length} 字符
          </span>
          <button
            type="button"
            className={action}
            ref={saveRef}
            aria-expanded={naming}
            onClick={() => setNaming(!naming)}
          >
            <BookmarkIcon className="h-4 w-4" />
            存为模板
          </button>
        </footer>
        {naming && (
          <form
            className="flex shrink-0 flex-wrap items-end gap-2 border-t border-border bg-muted/40 px-4 py-3 sm:px-5"
            onSubmit={async (event) => {
              event.preventDefault()
              if (!name.trim() || saving) return
              setSaving(true)
              try {
                await useLibraryStore.getState().savePromptTemplate(name, prompt)
                setNaming(false)
                saveRef.current?.focus()
                setName('')
              } catch {
                useStore.getState().showToast('模板保存失败，请重试', 'error')
              } finally {
                setSaving(false)
              }
            }}
          >
            <label className="min-w-0 flex-1 text-xs text-muted-foreground">
              模板名称
              <input
                autoFocus
                aria-label="模板名称"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={40}
                placeholder="给这段提示词起个名字"
                className="mt-1 block h-10 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
            <button
              type="submit"
              disabled={saving || !name.trim()}
              className="h-10 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              {saving ? '保存中…' : '保存模板'}
            </button>
          </form>
        )}
      </section>
    </Overlay>
  )
}
