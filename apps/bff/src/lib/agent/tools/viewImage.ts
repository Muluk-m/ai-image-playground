import { Type } from 'typebox'
import type { ResolvedAgentImage } from '../images'
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
})

interface Looked {
  readonly found: ResolvedAgentImage[]
  readonly missing: string[]
}

async function look(context: AgentToolContext, imageIds: readonly string[]): Promise<Looked> {
  const resolved = await Promise.all(
    imageIds.map(async (id) => ({ id, image: await context.images.resolve(id) })),
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
    '把指定 id 的图片内容取进上下文看一眼。只有你必须看清图里有什么才能往下做时才调（比如要照它描述细节、要判断它和用户说的是不是一回事）。改图不需要先看图：editImage 拿着图片 id 就能改，先白看一次只是多花一次钱。',
  guidance:
    '需要看清某张图的内容才能往下做时，用看图工具按图片 id 取它的内容；改图不必先看，editImage 拿着 id 就能改。',
  parameters,
  onError: 'continue',
  // 看图不落画布，也没有送进上游的提示词，所以起跑时只有一行标题。
  call: ({ imageIds }) => ({
    title: Array.isArray(imageIds) ? `看图：${imageIds.length} 张` : '看图',
  }),
  execute: (context) => async (_toolCallId, params) => {
    const { found, missing } = await look(context, params.imageIds)
    // 取不到只是 id 写错或那张图已经没了：把名单交回去让模型换 id，别把整轮停下。
    const missingLine = missing.length
      ? `这些 id 取不到图，请核对后重试：${missing.join('、')}。`
      : ''
    if (found.length === 0)
      return { content: [{ type: 'text', text: `没有取到任何图。${missingLine}` }], details: {} }
    // 块数与清单措辞复用参考图那一套：有选区的图照样出定位图与裁片，两条路不会各数各的。
    const evidence = await referenceEvidence(found)
    return {
      content: [
        {
          type: 'text',
          text: `已取到 ${found.length} 张图的内容。${missingLine}${evidence.manifest}`,
        },
        ...evidence.content,
      ],
      details: {},
    }
  },
})
