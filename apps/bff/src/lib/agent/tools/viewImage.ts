import { Type } from 'typebox'
import type { ResolvedAgentImage } from '../images'
import { toRegionDataUrl } from '../modelImage'
import { referenceEvidence } from '../selection-preview'
import { defineAgentTool } from './adapter'
import type { AgentToolContext } from './types'

/**
 * 一次最多拉几张。上限不是性能护栏而是意图护栏：不封顶时模型会把整块画布一口气拽进上下文，
 * 那正是「每轮无条件重发参考图」要治的病。
 */
const MAX_IMAGES = 4

const parameters = Type.Object({
  imageIds: Type.Array(Type.String({ description: '图片 id。' }), {
    minItems: 1,
    maxItems: MAX_IMAGES,
    description: `要看内容的图片 id，一次最多 ${MAX_IMAGES} 张；只填这一步真正要看的那几张。`,
  }),
  detail: Type.Optional(
    Type.Union([Type.Literal('preview'), Type.Literal('full')], {
      description:
        '默认 preview：缩略图足够认出画面里有什么。只有要照着写清细节（小字、纹理、精确配色）时才填 full——原图贵得多。',
    }),
  ),
  region: Type.Optional(
    Type.Object(
      {
        x: Type.Number({ minimum: 0, maximum: 1 }),
        y: Type.Number({ minimum: 0, maximum: 1 }),
        width: Type.Number({ minimum: 0, maximum: 1 }),
        height: Type.Number({ minimum: 0, maximum: 1 }),
      },
      {
        description:
          '只看原图的这一块，按 0~1 的比例给（左上角是 0,0）。框越小看得越清：取回来的像素数是固定的，全花在这一块上。只能配一个图片 id 用。',
      },
    ),
  ),
})

type ViewParams = {
  readonly imageIds: readonly string[]
  readonly detail?: 'preview' | 'full'
  readonly region?: { x: number; y: number; width: number; height: number }
}

interface Looked {
  readonly found: ResolvedAgentImage[]
  readonly missing: string[]
}

async function look(
  context: AgentToolContext,
  { imageIds, detail, region }: ViewParams,
): Promise<Looked> {
  // 取局部要的是原件的像素：从缩略图里裁一块，裁出来还是糊的。
  const variant = region || detail === 'full' ? 'original' : 'preview'
  const resolved = await Promise.all(
    imageIds.map(async (id) => {
      const image = await context.images.resolve(id, variant)
      if (!image || !region) return { id, image }
      return { id, image: { ...image, dataUrl: await toRegionDataUrl(image.dataUrl, region) } }
    }),
  )
  return {
    found: resolved.flatMap((one) => (one.image ? [one.image] : [])),
    missing: resolved.flatMap((one) => (one.image ? [] : [one.id])),
  }
}

export const viewImage = defineAgentTool({
  name: 'viewImage',
  modes: ['image', 'video'],
  label: '看图',
  description:
    '把指定 id 的图片内容取进上下文看一眼。只有你必须看清图里有什么才能往下做时才调（比如要照它描述细节、要判断它和用户说的是不是一回事）。默认给缩略图，够认出画面里有什么；要照着写清小字或纹理，用 region 只取那一块，比 detail=full 拉回整张原图划算得多。改图不需要先看图：editImage 拿着图片 id 就能改，先白看一次只是多花一次钱。',
  guidance:
    '需要看清某张图的内容才能往下做时，用看图工具按图片 id 取它的内容；改图不必先看，editImage 拿着 id 就能改。',
  parameters,
  onError: 'continue',
  // 看图不落画布，也没有送进上游的提示词，所以起跑时只有一行标题。
  call: ({ imageIds }) => ({
    title: Array.isArray(imageIds) ? `看图：${imageIds.length} 张` : '看图',
  }),
  execute: (context) => async (_toolCallId, params) => {
    // 局部只对一张图说得通：一个框套到四张尺寸不同的图上，裁出来的是四块不相干的东西。
    if (params.region && params.imageIds.length !== 1)
      return {
        content: [
          { type: 'text' as const, text: 'region 只能配一个图片 id 用，请一次看一张的局部。' },
        ],
        details: {},
      }
    const { found, missing } = await look(context, params)
    // 取不到只是 id 写错或那张图已经没了：把名单交回去让模型换 id，别把整轮停下。
    const missingLine = missing.length
      ? `这些 id 取不到图，请核对后重试：${missing.join('、')}。`
      : ''
    if (found.length === 0)
      return { content: [{ type: 'text', text: `没有取到任何图。${missingLine}` }], details: {} }
    // 块数与清单措辞复用参考图那一套：有选区的图照样出定位图与裁片，两条路不会各数各的。
    const evidence = await referenceEvidence(found)
    const what = params.region ? '局部' : params.detail === 'full' ? '原图' : '缩略图'
    return {
      content: [
        {
          type: 'text',
          text: `已取到 ${found.length} 张图的${what}。${missingLine}${evidence.manifest}`,
        },
        ...evidence.content,
      ],
      details: {},
    }
  },
})
