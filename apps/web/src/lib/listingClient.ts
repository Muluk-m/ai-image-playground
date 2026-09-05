import { bffBaseUrl } from './runtimeConfig'

export interface ListingImages {
  asin: string
  title?: string
  images: string[]
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

const UNAVAILABLE = '抓不到这条链接的图集'

/** 图片字节走 BFF 代理：亚马逊图床不发 CORS 头，浏览器直接取不到像素。 */
export function listingImageProxyUrl(imageUrl: string): string {
  return `${bffBaseUrl()}/api/remix/image?url=${encodeURIComponent(imageUrl)}`
}

export async function fetchListingImages(
  url: string,
  fetcher: Fetcher = fetch,
): Promise<ListingImages> {
  const response = await fetcher(`${bffBaseUrl()}/api/remix/listing`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  })
  const listing = response.ok ? parseListing(await response.json()) : null
  if (!listing) throw new Error(UNAVAILABLE)
  return listing
}

function parseListing(body: unknown): ListingImages | null {
  if (typeof body !== 'object' || body === null) return null
  const { asin, title, images } = body as Record<string, unknown>
  if (typeof asin !== 'string' || !Array.isArray(images)) return null
  if (!images.every((image) => typeof image === 'string')) return null
  return { asin, ...(typeof title === 'string' ? { title } : {}), images: images as string[] }
}
