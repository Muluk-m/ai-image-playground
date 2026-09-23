import './guide.css'

/**
 * 指南页唯一的脚本：目录跟着阅读位置高亮，只展开当前章节的小节。
 * 正文是构建期渲染好的静态 HTML，脚本没跑也能完整阅读与跳转。
 */

/** 标题越过顶栏下沿这么多像素才算「正在读」。顶栏 56px，再留一点余量。 */
const READING_LINE = 112

const headings = [...document.querySelectorAll<HTMLElement>('[data-heading]')]
const links = [...document.querySelectorAll<HTMLAnchorElement>('[data-toc]')]
const groups = [...document.querySelectorAll<HTMLElement>('[data-toc-group]')]
const parentOf = new Map(links.map((link) => [link.dataset.toc, link.dataset.tocParent]))

let frame = 0
let lastId: string | undefined

function highlight(): void {
  frame = 0
  let current = headings[0]
  for (const heading of headings) {
    if (heading.getBoundingClientRect().top > READING_LINE) break
    current = heading
  }
  const id = current?.id
  if (id === lastId) return
  lastId = id
  const section = parentOf.get(id) ?? id
  for (const link of links) {
    if (link.dataset.toc === id || link.dataset.toc === section)
      link.setAttribute('aria-current', 'true')
    else link.removeAttribute('aria-current')
  }
  for (const group of groups) group.hidden = group.dataset.tocGroup !== section
}

window.addEventListener(
  'scroll',
  () => {
    frame ||= requestAnimationFrame(highlight)
  },
  { passive: true },
)
highlight()

// 窄屏目录是折叠面板：点了某一节就收起来，别挡着正文。
const mobileToc = document.querySelector<HTMLDetailsElement>('[data-mobile-toc]')
mobileToc?.addEventListener('click', (event) => {
  if ((event.target as Element).closest('a')) mobileToc.open = false
})
