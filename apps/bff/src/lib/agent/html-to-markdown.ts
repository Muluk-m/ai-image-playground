/**
 * 把一页 HTML 压成模型读得动的 markdown，外加这一页上可用的图片候选。
 *
 * 用 Bun 自带的 `HTMLRewriter` 流式扫一遍，不引第三方解析器：它是浏览器同款的容错解析，
 * 半截标签、没闭合的 `<p>`、属性值里带尖括号这些真实网页的常态都吃得下，而拿正则拆 HTML
 * 在这些地方一律拆错。
 *
 * 只保留读得出意思的那部分：标题、各级小标题、段落、列表项、表格行、链接文字与它的绝对地址。
 * 脚本、样式、导航、页脚、侧栏、表单整块丢掉——它们在每一页上都一样，占的却是模型的钱。
 */

/** 正文优先取的容器。页面自己声明了正文在哪儿时，导航与推荐位就不必靠标签名一条条猜。 */
const MAIN_SELECTORS = 'main, article, [role="main"]'

/**
 * 整块丢掉的东西：要么不是内容（脚本、样式），要么在每一页上都一样（导航、页脚）。
 * `title` 也在里面——它单独收成标题，正文里不必再出现一遍。
 */
const DROPPED =
  'script, style, noscript, svg, iframe, nav, footer, header, aside, form, template, title'

/** 一页最多带回几张图片候选。给模型挑的，不是这一页的图库目录。 */
const MAX_IMAGE_CANDIDATES = 12

/** 短边小于这个数的 `<img>` 基本都是计数像素与图标，不值得让模型看见。 */
const MIN_IMAGE_SIDE = 64

/**
 * 块级元素收尾补一个换行。行内元素不补，否则一句话会被拆成一堆碎行；列表项与小标题也不在
 * 这里——它们自己在开头起的那一行就够了，两头都加会给每一项后面垫一个空行。
 * 表格的单元格同理：断行的是 `tr`，`td` 断了整张表就摊成一串断句。
 */
const BLOCK_TAGS = 'p, div, section, tr, blockquote, pre, h1, h2, h3, h4, h5, h6'

const HEADING_PREFIX: Record<string, string> = {
  h1: '# ',
  h2: '## ',
  h3: '### ',
  h4: '#### ',
  h5: '##### ',
  h6: '###### ',
}

export interface WebPageImage {
  readonly url: string
  readonly alt: string
}

export interface WebPageContent {
  readonly title: string
  readonly markdown: string
  readonly images: readonly WebPageImage[]
}

function absolute(href: string, base: string): string {
  // 空地址会被 `new URL` 解析成页面自己，那不是一张图也不是一条链接。
  if (!href.trim()) return ''
  try {
    const url = new URL(href, base)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : ''
  } catch {
    return ''
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

/**
 * `HTMLRewriter` 交出来的文本块与属性值都是**原样的源码**，实体没有解开：不解的话图片地址里的
 * `&amp;` 会原样递给取图工具，请求的就是另一个网址。只解常见的几个具名实体与数字实体——
 * 冷门的具名实体留着原样，模型读得懂，地址里也不会出现它们。
 */
function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10)
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
}

/** 属性值，实体已解开。 */
function attribute(element: HTMLRewriterTypes.Element, name: string): string {
  return decodeEntities(element.getAttribute(name) ?? '')
}

/** `srcset` 是「地址 宽度」的逗号列表；取第一条就够——挑哪个分辨率不是模型该操心的事。 */
function fromSrcset(value: string): string {
  const first = value.split(',')[0]?.trim() ?? ''
  return first.split(/\s+/)[0] ?? ''
}

/** 一眼能判死的图片：内联数据、矢量图标，以及标了尺寸且小得不像内容的那些。 */
function skipImage(url: string, width: string | null, height: string | null): boolean {
  if (!url) return true
  if (/\.svg(\?|#|$)/i.test(url)) return true
  for (const side of [width, height]) {
    const measured = side ? Number.parseInt(side, 10) : Number.NaN
    if (Number.isFinite(measured) && measured < MIN_IMAGE_SIDE) return true
  }
  return false
}

/**
 * 一遍扫完：正文与图片候选一起收。
 *
 * `<main>` / `<article>` 出现之后就只收它里面的东西，**之前收到的一并丢掉**。网页的顺序
 * 是「导航在前、正文在后」，等正文容器出现了才知道前面那些是包装。整页没有正文容器时才退回收全页。
 */
export async function htmlToMarkdown(html: string, baseUrl: string): Promise<WebPageContent> {
  let title = ''
  let dropDepth = 0
  /** 正文容器里收到的；`null` 表示这一页还没出现正文容器。 */
  let scoped: string[] | null = null
  const all: string[] = []
  const images: WebPageImage[] = []
  const seenImages = new Set<string>()

  const push = (text: string) => {
    if (dropDepth > 0) return
    ;(scoped ?? all).push(text)
  }

  const rewriter = new HTMLRewriter()
    .on('title', {
      text(chunk) {
        title += chunk.text
      },
    })
    .on(DROPPED, {
      element(element) {
        dropDepth += 1
        element.onEndTag(() => {
          dropDepth -= 1
        })
      },
    })
    .on(MAIN_SELECTORS, {
      element() {
        // 嵌套的 article 不再重开一份：第一个正文容器就是这一页的正文。
        if (dropDepth === 0 && scoped === null) scoped = []
      },
    })
    .on('meta', {
      element(element) {
        const property = attribute(element, 'property') || attribute(element, 'name')
        if (property !== 'og:image' && property !== 'twitter:image') return
        const url = absolute(attribute(element, 'content'), baseUrl)
        if (!url || seenImages.has(url)) return
        seenImages.add(url)
        // 社交卡片那张图是作者自己挑的主图，排在所有 `<img>` 前面。
        images.unshift({ url, alt: '' })
      },
    })
    .on('img', {
      element(element) {
        const raw =
          attribute(element, 'src') ||
          attribute(element, 'data-src') ||
          fromSrcset(attribute(element, 'srcset'))
        const url = absolute(raw, baseUrl)
        if (skipImage(url, element.getAttribute('width'), element.getAttribute('height'))) return
        if (seenImages.has(url)) return
        seenImages.add(url)
        images.push({ url, alt: attribute(element, 'alt').trim() })
      },
    })
    .on('h1, h2, h3, h4, h5, h6', {
      element(element) {
        push(`\n${HEADING_PREFIX[element.tagName] ?? ''}`)
      },
    })
    .on('li', {
      element() {
        push('\n- ')
      },
    })
    .on('td, th', {
      // 表格靠分隔符保住「这几个格子是一行」，不然整张表会摊成一串断句。
      element() {
        push(' | ')
      },
    })
    .on('br', {
      element() {
        push('\n')
      },
    })
    .on('a', {
      element(element) {
        if (dropDepth > 0) return
        // 链接地址不在这里解实体：它与正文一起在收尾时解一次，这里再解就解了两遍。
        const href = absolute(element.getAttribute('href') ?? '', baseUrl)
        if (!href) return
        // 链接文字要等它闭合才收得齐，所以先记下从哪儿开始，闭合时把那几段换成一条链接。
        const target = scoped ?? all
        const start = target.length
        element.onEndTag(() => {
          const text = target.slice(start).join('').replace(/\s+/g, ' ').trim()
          target.length = start
          // 没有文字的链接（图标、整块包着图片的链）留着只会是一行光秃秃的网址。
          if (text) target.push(`[${text}](${href})`)
        })
      },
    })
    .on(BLOCK_TAGS, {
      element(element) {
        element.onEndTag(() => push('\n'))
      },
    })
    .on('*', {
      text(chunk) {
        if (chunk.text) push(chunk.text)
      },
    })

  await rewriter.transform(new Response(html)).text()

  return {
    title: decodeEntities(title).replace(/\s+/g, ' ').trim(),
    // 文本块可能恰好切在一个实体中间，所以拼完整页再解。
    markdown: tidy(decodeEntities((scoped ?? all).join(''))),
    images,
  }
}

/**
 * 网页里的空白是排版用的，对模型只是钱：行内空白压成一个空格，空行最多留一个。
 * 一并去掉只剩分隔符的表格行——那是排版用的空行，不是数据。
 */
function tidy(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .map((line) => (/^(\|\s*)+$/.test(line) ? '' : line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 交给模型的图片候选清单：它要递给取图工具的就是这里的网址。 */
export function imageCandidateList(images: readonly WebPageImage[]): string {
  const listed = images.slice(0, MAX_IMAGE_CANDIDATES)
  if (listed.length === 0) return ''
  const lines = listed.map((image) => `- ${image.url}${image.alt ? ` （${image.alt}）` : ''}`)
  return `\n\n图片候选：\n${lines.join('\n')}`
}
