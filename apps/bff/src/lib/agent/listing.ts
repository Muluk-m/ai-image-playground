/**
 * 商品页与商品图地址的纯解析层：不发请求，抓取在 `tools/fetchListingImages.ts`。
 *
 * 2026-09-04 上线过一版（`lib/amazonListing.ts`），随竞品重混一起在 #650 下线；这是同一份
 * 解析规则搬回智能体工具下，多了一层白名单校验：交给取图那一步的地址必须落在亚马逊自己的
 * 图片 CDN 上，否则页面里塞一个内网地址就成了我们代抓。
 */

export interface ParsedListingUrl {
  readonly asin: string
  readonly canonicalUrl: string
}

export interface ParsedListingPage {
  readonly title?: string
  readonly images: readonly string[]
}

const AMAZON_HOST = /^(?:www\.)?amazon\.[a-z]{2,}(?:\.[a-z]{2,})?$/
const ASIN_PATH = /\/(?:dp|gp\/product)\/([a-z0-9]{10})(?:\/|$)/i

/** 一页最多收这么多张；再多是变体图与推荐位，对做图没用。 */
const MAX_IMAGES = 20

/** 亚马逊图片 CDN；商品图路径固定在 /images/I/ 下，/images/G/ 是站点素材。 */
const IMAGE_HOST_SUFFIXES = ['.ssl-images-amazon.com', '.images-amazon.com'] as const
const IMAGE_HOSTS = ['m.media-amazon.com', 'images-amazon.com'] as const
const PRODUCT_IMAGE_PATH = '/images/I/'

function parseUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

/** 商品页地址 → ASIN 与规范地址。认不出就是不支持的地址，不猜。 */
export function parseListingUrl(input: string): ParsedListingUrl | null {
  const url = parseUrl(input.trim())
  if (!url) return null
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (!AMAZON_HOST.test(url.hostname)) return null

  const asin = ASIN_PATH.exec(url.pathname)?.[1]?.toUpperCase()
  if (!asin) return null
  return { asin, canonicalUrl: `https://${url.hostname}/dp/${asin}` }
}

/** 这个地址是不是亚马逊自家图片 CDN 上的一张商品图。 */
export function isListingImageUrl(input: string): boolean {
  const url = parseUrl(input)
  if (!url || url.protocol !== 'https:') return false
  const onCdn =
    IMAGE_HOSTS.some((host) => url.hostname === host) ||
    IMAGE_HOST_SUFFIXES.some((suffix) => url.hostname.endsWith(suffix))
  return onCdn && url.pathname.startsWith(PRODUCT_IMAGE_PATH)
}

/** `..._AC_US40_.jpg` 这类尺寸段去掉才是原图地址。 */
function stripSizeSuffix(url: string): string {
  return url.replace(/\._[A-Za-z0-9,_-]+_\.(jpg|jpeg|png|gif|webp)$/i, '.$1')
}

/** 页面内嵌的图集 JSON 里的大图；这是最准的一条，缩略图列表只是它的兜底。 */
function collectHiResImages(html: string): string[] {
  const found: string[] = []
  for (const match of html.matchAll(/"hiRes"\s*:\s*"([^"]+)"/g)) {
    found.push(match[1]!.replace(/\\\//g, '/'))
  }
  return found
}

function collectAltImages(html: string): string[] {
  const start = html.indexOf('id="altImages"')
  if (start === -1) return []
  const end = html.indexOf('</ul>', start)
  const block = html.slice(start, end === -1 ? undefined : end)

  const found: string[] = []
  for (const match of block.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)) {
    found.push(stripSizeSuffix(match[1]!))
  }
  return found
}

function parseTitle(html: string): string | undefined {
  const title = /id="productTitle"[^>]*>([^<]*)</.exec(html)?.[1]?.replace(/\s+/g, ' ').trim()
  return title || undefined
}

export function parseListingPage(html: string): ParsedListingPage {
  const hiRes = collectHiResImages(html).filter(isListingImageUrl)
  const candidates = hiRes.length > 0 ? hiRes : collectAltImages(html).filter(isListingImageUrl)
  const images = [...new Set(candidates)].slice(0, MAX_IMAGES)

  const title = parseTitle(html)
  return title === undefined ? { images } : { title, images }
}
