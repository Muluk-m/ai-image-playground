import { getRuntimeConfig } from '../../../lib/runtimeConfig'

export interface ListingImages {
  asin: string
  title?: string
  images: string[]
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

function bffBase(): string {
  return getRuntimeConfig().bff.baseUrl.replace(/\/+$/, '')
}

/** 图片字节走 BFF 代理：亚马逊图床不发 CORS 头，浏览器直接取不到像素。 */
export function listingImageProxyUrl(imageUrl: string): string {
  return `${bffBase()}/api/remix/image?url=${encodeURIComponent(imageUrl)}`
}

export async function fetchListingImages(
  url: string,
  fetcher: Fetcher = fetch,
): Promise<ListingImages> {
  const response = await fetcher(`${bffBase()}/api/remix/listing`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  })
  if (!response.ok) throw new Error('抓不到这条链接的图集')

  const body: unknown = await response.json()
  if (typeof body !== 'object' || body === null) throw new Error('抓不到这条链接的图集')
  const { asin, title, images } = body as Record<string, unknown>
  if (typeof asin !== 'string' || !Array.isArray(images)) throw new Error('抓不到这条链接的图集')
  if (!images.every((image): image is string => typeof image === 'string')) {
    throw new Error('抓不到这条链接的图集')
  }

  return { asin, ...(typeof title === 'string' ? { title } : {}), images }
}
