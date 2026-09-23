/** PROTOTYPE — throwaway. 方案切换浮条、目录高亮与方案 C 的站内搜索。 */
import '../guide.css'
import './prototype.css'

const body = document.body
const current = body.dataset.variant ?? 'A'
const variants = (body.dataset.variants ?? '').split(',').map((entry) => {
  const [key, name] = entry.split(':')
  return { key: key!, name: name! }
})

function go(step: number): void {
  const index = variants.findIndex((v) => v.key === current)
  const next = variants[(index + step + variants.length) % variants.length]!
  const url = new URL(window.location.href)
  url.searchParams.set('variant', next.key)
  window.location.assign(url.toString())
}

const bar = document.createElement('div')
bar.className =
  'fixed bottom-5 left-1/2 z-[100] flex -translate-x-1/2 items-center gap-1 rounded-full bg-[#111] p-1 text-[13px] text-white shadow-2xl ring-1 ring-white/20'
bar.innerHTML = `<button data-step="-1" class="grid h-8 w-8 place-items-center rounded-full hover:bg-white/15">←</button><span class="px-3 font-medium">PROTOTYPE · ${current} ${variants.find((v) => v.key === current)?.name ?? ''}</span><button data-step="1" class="grid h-8 w-8 place-items-center rounded-full hover:bg-white/15">→</button>`
bar.addEventListener('click', (event) => {
  const step = (event.target as HTMLElement).closest<HTMLElement>('[data-step]')?.dataset.step
  if (step) go(Number(step))
})
document.body.append(bar)
window.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement
  if (target.closest('input, textarea, [contenteditable="true"]')) return
  if (event.key === 'ArrowLeft') go(-1)
  if (event.key === 'ArrowRight') go(1)
})

// 目录高亮：与正式页同一条规则，另外让方案 C 的折叠目录跟着展开。
const headings = [...document.querySelectorAll<HTMLElement>('[data-heading]')]
const links = [...document.querySelectorAll<HTMLAnchorElement>('[data-toc]')]
const parentOf = new Map(links.map((link) => [link.dataset.toc, link.dataset.tocParent]))
let frame = 0
function highlight(): void {
  frame = 0
  let active = headings[0]
  for (const heading of headings) {
    if (heading.getBoundingClientRect().top > 140) break
    active = heading
  }
  const id = active?.id
  const section = parentOf.get(id) ?? id
  for (const link of links) {
    if (link.dataset.toc === id || link.dataset.toc === section)
      link.setAttribute('aria-current', 'true')
    else link.removeAttribute('aria-current')
  }
  for (const group of document.querySelectorAll<HTMLElement>('[data-toc-group]')) {
    const mine = group.dataset.tocGroup === section
    if (group instanceof HTMLDetailsElement) group.open = mine
    else group.hidden = !mine
  }
}
window.addEventListener('scroll', () => (frame ||= requestAnimationFrame(highlight)), {
  passive: true,
})
highlight()

// 方案 C：按小节标题与正文做本地搜索。
const input = document.querySelector<HTMLInputElement>('[data-search-input]')
const results = document.querySelector<HTMLElement>('[data-search-results]')
if (input && results) {
  const index = [...document.querySelectorAll<HTMLElement>('h3[data-heading]')].map((heading) => ({
    id: heading.id,
    title: heading.textContent ?? '',
    text: heading.parentElement?.textContent ?? '',
  }))
  input.addEventListener('input', () => {
    const query = input.value.trim().toLowerCase()
    const hits = query
      ? index.filter((item) => item.text.toLowerCase().includes(query)).slice(0, 8)
      : []
    results.hidden = hits.length === 0
    results.innerHTML = hits
      .map(
        (hit) =>
          `<a href="#${hit.id}" class="block rounded-xl px-3 py-2.5 text-[14px] text-foreground hover:bg-muted">${hit.title}</a>`,
      )
      .join('')
  })
  results.addEventListener('click', () => {
    results.hidden = true
  })
}
