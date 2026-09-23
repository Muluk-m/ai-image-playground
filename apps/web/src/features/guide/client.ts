import './guide.css'

/**
 * 指南页的脚本：章节页的目录高亮、全站搜索与示例提示词的复制按钮。
 * 正文是构建期渲染好的静态 HTML，脚本没跑也能完整阅读与跳转。
 */

/* ── 目录高亮：标题越过顶栏下沿才算「正在读」。顶栏底边约 64px，再留余量。 ── */

const READING_LINE = 120
const headings = [...document.querySelectorAll<HTMLElement>('[data-heading]')]
const tocLinks = [...document.querySelectorAll<HTMLAnchorElement>('[data-toc]')]
if (headings.length > 0 && tocLinks.length > 0) {
  let frame = 0
  let lastId: string | undefined
  const highlight = () => {
    frame = 0
    let current: HTMLElement | undefined
    for (const heading of headings) {
      if (heading.getBoundingClientRect().top > READING_LINE) break
      current = heading
    }
    const id = current?.id
    if (id === lastId) return
    lastId = id
    for (const link of tocLinks) {
      if (link.dataset.toc === id) link.setAttribute('aria-current', 'true')
      else link.removeAttribute('aria-current')
    }
  }
  window.addEventListener(
    'scroll',
    () => {
      frame ||= requestAnimationFrame(highlight)
    },
    { passive: true },
  )
  highlight()
}

// 窄屏目录是折叠面板：点了某一节就收起来，别挡着正文。
const mobileToc = document.querySelector<HTMLDetailsElement>('[data-mobile-toc]')
mobileToc?.addEventListener('click', (event) => {
  if ((event.target as Element).closest('a')) mobileToc.open = false
})

/* ── 复制示例提示词 ── */

document.addEventListener('click', (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>('[data-copy]')
  const text = button?.closest('figure')?.querySelector('blockquote')?.textContent
  if (!button || !text) return
  const label = button.querySelector('span')
  void navigator.clipboard.writeText(text).then(() => {
    if (!label) return
    const idle = label.textContent
    label.textContent = button.dataset.copied ?? idle
    setTimeout(() => {
      label.textContent = idle
    }, 1500)
  })
})

/* ── 站内搜索：索引在首次打开时拉取，按小节标题与正文做子串匹配。 ── */

interface Entry {
  chapter: string
  title: string
  url: string
  text: string
}

const dialog = document.querySelector<HTMLDialogElement>('[data-search]')
const input = dialog?.querySelector<HTMLInputElement>('[data-search-input]')
const results = dialog?.querySelector<HTMLElement>('[data-search-results]')

if (dialog && input && results) {
  let index: Promise<Entry[]> | null = null
  let active = 0

  const load = () => {
    index ??= fetch(dialog.dataset.index!)
      .then((response) => (response.ok ? (response.json() as Promise<Entry[]>) : []))
      .catch(() => {
        index = null
        return []
      })
    return index
  }

  const escape = (text: string) =>
    text.replace(
      /[&<>"]/g,
      (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!,
    )

  /** 命中处前后各留一段，高亮第一个关键词。 */
  const snippet = (text: string, term: string) => {
    const at = text.toLowerCase().indexOf(term)
    if (at < 0) return escape(text.slice(0, 80))
    const start = Math.max(0, at - 24)
    const before = (start > 0 ? '…' : '') + text.slice(start, at)
    const hit = text.slice(at, at + term.length)
    const after = text.slice(at + term.length, at + term.length + 60)
    return `${escape(before)}<mark class="rounded-sm bg-primary/20 px-0.5 text-foreground">${escape(hit)}</mark>${escape(after)}`
  }

  const items = () => [...results.querySelectorAll<HTMLAnchorElement>('[data-result]')]
  const select = (next: number) => {
    const list = items()
    if (list.length === 0) return
    active = (next + list.length) % list.length
    list.forEach((item, i) => item.setAttribute('aria-selected', String(i === active)))
    list[active]!.scrollIntoView({ block: 'nearest' })
  }

  const search = async () => {
    const terms = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (terms.length === 0) {
      results.innerHTML = ''
      return
    }
    const entries = await load()
    const hits = entries
      .map((entry) => {
        const title = entry.title.toLowerCase()
        const body = `${title} ${entry.text.toLowerCase()}`
        if (!terms.every((term) => body.includes(term))) return null
        return { entry, score: terms.filter((term) => title.includes(term)).length }
      })
      .filter((hit) => hit !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
    active = 0
    results.innerHTML =
      hits.length === 0
        ? `<p class="px-3 py-8 text-center text-[14px] text-muted-foreground">${escape(dialog.dataset.empty ?? '')}</p>`
        : hits
            .map(
              ({ entry }, i) =>
                `<a href="${escape(entry.url)}" data-result role="option" aria-selected="${i === 0}" class="block rounded-xl px-3 py-2.5 aria-selected:bg-muted"><span class="block text-[12px] text-muted-foreground">${escape(entry.chapter)}</span><span class="block text-[14.5px] font-medium text-foreground">${escape(entry.title)}</span><span class="mt-0.5 block truncate text-[13px] text-muted-foreground">${snippet(entry.text, terms[0]!)}</span></a>`,
            )
            .join('')
  }

  const open = () => {
    if (dialog.open) return
    void load()
    dialog.showModal()
    input.select()
  }

  for (const trigger of document.querySelectorAll('[data-search-open]'))
    trigger.addEventListener('click', open)
  window.addEventListener('keydown', (event) => {
    const typing = (event.target as Element).closest('input, textarea, [contenteditable="true"]')
    if ((event.key === 'k' && (event.metaKey || event.ctrlKey)) || (event.key === '/' && !typing)) {
      event.preventDefault()
      open()
    }
  })
  input.addEventListener('input', () => void search())
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') select(active + 1)
    else if (event.key === 'ArrowUp') select(active - 1)
    else if (event.key === 'Enter') items()[active]?.click()
    else return
    event.preventDefault()
  })
  // 点遮罩关闭；点结果后关闭，同页锚点跳转才看得到。
  dialog.addEventListener('click', (event) => {
    const target = event.target as Element
    if (target === dialog || target.closest('[data-result]')) dialog.close()
  })
}
