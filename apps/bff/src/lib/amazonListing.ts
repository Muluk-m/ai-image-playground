/** 亚马逊商品页与图片地址的纯解析层：不发请求，抓取在 listingFetch.ts。 */

export interface ParsedListingUrl {
  readonly asin: string
  readonly canonicalUrl: string
}

export interface ParsedListingPage {
  readonly title?: string
  readonly images: readonly string[]
}

const AMAZON_HOST = /^(?:www\.)?amazon\.[a-z]{2,}(?:\.[a-z]{2,})?$/
const ASIN = /^[A-Z0-9]{10}$/
const MAX_IMAGES = 30

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

export function parseAmazonListingUrl(input: string): ParsedListingUrl | null {
  const url = parseUrl(input.trim())
  if (!url) return null
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (!AMAZON_HOST.test(url.hostname)) return null

  const segments = url.pathname.split('/').filter(Boolean)
  let candidate: string | undefined
  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index] === 'dp') candidate = segments[index + 1]
    else if (segments[index] === 'gp' && segments[index + 1] === 'product')
      candidate = segments[index + 2]
    if (candidate) break
  }

  const asin = candidate?.toUpperCase()
  if (!asin || !ASIN.test(asin)) return null
  return { asin, canonicalUrl: `https://${url.hostname}/dp/${asin}` }
}

export function isAllowedListingImageUrl(input: string): boolean {
  const url = parseUrl(input)
  if (!url || url.protocol !== 'https:') return false
  return (
    IMAGE_HOSTS.includes(url.hostname as (typeof IMAGE_HOSTS)[number]) ||
    IMAGE_HOST_SUFFIXES.some((suffix) => url.hostname.endsWith(suffix))
  )
}

function isProductImageUrl(input: string): boolean {
  const url = parseUrl(input)
  return url !== null && isAllowedListingImageUrl(input) && url.pathname.startsWith(PRODUCT_IMAGE_PATH)
}

/** `..._AC_US40_.jpg` 这类尺寸段去掉才是原图地址。 */
function stripSizeSuffix(url: string): string {
  return url.replace(/\._[A-Za-z0-9,_-]+_\.(jpg|jpeg|png|gif|webp)$/i, '.$1')
}

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
    found.push(stripSizeSuffix(match[1]!.replace(/&amp;/g, '&')))
  }
  return found
}

function parseTitle(html: string): string | undefined {
  const match = html.match(/id="productTitle"[^>]*>([^<]*)</)
  const title = match?.[1]?.replace(/\s+/g, ' ').trim()
  return title || undefined
}

export function parseListingPage(html: string): ParsedListingPage {
  const hiRes = collectHiResImages(html).filter(isProductImageUrl)
  const candidates = hiRes.length > 0 ? hiRes : collectAltImages(html).filter(isProductImageUrl)

  const images: string[] = []
  for (const url of candidates) {
    if (images.length >= MAX_IMAGES) break
    if (!images.includes(url)) images.push(url)
  }

  const title = parseTitle(html)
  return title === undefined ? { images } : { title, images }
}
