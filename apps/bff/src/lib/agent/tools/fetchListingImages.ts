import type { AgentFetchedImage } from '@image-playground/shared'
import { Type } from 'typebox'
import { safeFetch } from '../../safeFetch'
import { fetchAndClaimImage, fetchedImageSize } from '../fetched-image'
import { parseListingPage, parseListingUrl } from '../listing'
import { agentSaveToolsAvailable } from '../saves'
import { referenceEvidence } from '../selection-preview'
import { defineAgentTool } from './adapter'
import { AgentToolError } from './errors'
import { safeFetchToolError } from './webError'

/** 商品页是用户等着的一步：抓页 15 秒封顶，慢过这个多半是对方在防爬。 */
const PAGE_TIMEOUT_MS = 15_000

/** 商品页的 HTML 常有一兆多，但也就这个量级；再大的不是商品页。 */
const MAX_PAGE_BYTES = 5 * 1024 * 1024

const DEFAULT_COUNT = 4
const MAX_COUNT = 8

/**
 * 不带浏览器 UA 与英文 Accept-Language 时亚马逊直接回验证码页；2026-09 那一版就是这么配的，
 * 这次原样沿用。
 */
const BROWSER_HEADERS: Readonly<Record<string, string>> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
}

const PAGE_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'

const parameters = Type.Object({
  url: Type.String({
    description: '亚马逊商品页地址（含 /dp/ 或 /gp/product/ 的那种），不是搜索页或店铺首页。',
  }),
  count: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_COUNT,
      description: `最多取几张，1-${MAX_COUNT}，默认 ${DEFAULT_COUNT}。主图在最前面，按需要取，不要一次全取。`,
    }),
  ),
})

/** 起跑那一行标签：认得出 ASIN 就写它，认不出就只写在抓商品图。 */
function title(url: unknown): string {
  const asked = typeof url === 'string' ? parseListingUrl(url) : null
  return asked ? `抓商品图：${asked.asin}` : '抓商品图'
}

/**
 * 抓商品页整套主图：解析出图集地址，逐张收进这个人的媒体库并由本会话认领。
 *
 * 与 `fetchImage` 同一条落库路径（`fetched-image.ts`），所以交回的 id 照样是普通图片 id：
 * editImage 直接拿它当参考图或目标图，产物也照样落画布。这里多的只是「从一页 HTML 里
 * 认出哪几张是商品图」，并且只放行亚马逊自家图片 CDN 上的地址。
 */
export const fetchListingImages = defineAgentTool({
  name: 'fetchListingImages',
  modes: ['image', 'video'],
  label: '抓商品图',
  description:
    '给一个亚马逊商品页地址，把那一页的商品主图整套取进来，存成这个人媒体库里的图并交回图片 id。图按页面顺序给，第一张是主图。那些 id 和别的图片 id 一样用：交给 editImage 当参考图或目标图，交给 viewImage 看内容。单张网图直链用 fetchImage。',
  guidance:
    '用户给了亚马逊商品链接、或者要照着某个在售商品做图时，用抓商品图工具把那一页的图取回来，再拿这些图片 id 去改图；默认取主图那几张，用户没说要整套就不要全取。抓回来的是别人的商品图，只当参考与素材，不直接当交付物。',
  parameters,
  // 地址不对、对方回验证码页，模型换个做法就能继续，不该把整轮停下。
  onError: 'continue',
  // 要写这个人的媒体库，与取网图同一条门槛。
  available: (_mode, audience) => agentSaveToolsAvailable(audience),
  call: ({ url }) => ({ title: title(url) }),
  execute: (context) => async (_toolCallId, params, signal) => {
    const { userId, conversationId } = context
    if (!userId) throw new AgentToolError('authentication_required', '抓商品图要先登录。')
    const listing = parseListingUrl(params.url)
    if (!listing) {
      throw new AgentToolError(
        'invalid_params',
        '这不是能识别的亚马逊商品页地址（要带 /dp/ 或 /gp/product/ 的那种）。别的站点用 webFetch 读出图片候选，再用 fetchImage 取单张。',
      )
    }
    const page = await safeFetch(listing.canonicalUrl, {
      maxBytes: MAX_PAGE_BYTES,
      timeoutMs: PAGE_TIMEOUT_MS,
      accept: PAGE_ACCEPT,
      headers: BROWSER_HEADERS,
      ...(signal ? { signal } : {}),
    }).catch((error) => {
      throw safeFetchToolError(error)
    })
    const parsed = parseListingPage(new TextDecoder().decode(page.bytes))
    // 一张都没解析出来：要么是验证码页，要么页面结构变了，两种都不是换个参数能救的。
    if (parsed.images.length === 0) {
      throw new AgentToolError(
        'upstream_error',
        '这一页没拿到商品图（多半被亚马逊挡成了验证码页）。可以让用户把图片直链发过来，再用 fetchImage 取。',
      )
    }

    const wanted = Math.min(params.count ?? DEFAULT_COUNT, MAX_COUNT)
    const images: AgentFetchedImage[] = []
    const failures: string[] = []
    for (const [index, url] of parsed.images.slice(0, wanted).entries()) {
      try {
        images.push(
          await fetchAndClaimImage({
            url,
            userId,
            conversationId,
            name: `${parsed.title ?? listing.asin} ${index + 1}`.slice(0, 60),
            headers: BROWSER_HEADERS,
            ...(signal ? { signal } : {}),
          }),
        )
      } catch (error) {
        // 一张取不下来不该把整套废掉：记下来，其余照常交付。中止与配额用尽要往上抛。
        if (error instanceof AgentToolError && error.code === 'invalid_params') {
          failures.push(url)
          continue
        }
        if (images.length === 0) throw error
        failures.push(url)
        break
      }
    }
    if (images.length === 0) {
      throw new AgentToolError('upstream_error', '解析出了商品图地址，但一张也没取下来。')
    }

    const resolved = await Promise.all(
      images.map((image) => context.images.resolve(image.imageId, 'preview')),
    )
    const evidence = await referenceEvidence(resolved.filter((image) => image !== null))
    const listed = images
      .map((image, index) => `${index + 1}. 图片 id ${image.imageId}${fetchedImageSize(image)}`)
      .join('\n')
    const missed = failures.length > 0 ? `\n另有 ${failures.length} 张没取下来。` : ''
    return {
      content: [
        {
          type: 'text' as const,
          text: `已取到 ${images.length} 张商品图（${parsed.title ?? listing.asin}，来源 ${listing.canonicalUrl}）：\n${listed}${missed}\n这些是别人的商品图，只当参考与素材。${evidence.manifest}`,
        },
        ...evidence.content,
      ],
      details: { fetchedImages: images },
    }
  },
})
