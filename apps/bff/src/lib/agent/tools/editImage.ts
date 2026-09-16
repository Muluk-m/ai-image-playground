import type { AgentTool } from '@earendil-works/pi-agent-core'
import { agentTitleLine } from '@image-playground/shared'
import { Type } from 'typebox'
import { requireAgentImages } from '../images'
import { agentImageCount, imageCountParameter } from './queueParams'
import { runQueueTask } from './queueTask'
import type { AgentToolDefinition, AgentToolDetails } from './types'

const TITLE_MAX_CHARS = 40
const MAX_REFERENCES = 4

const parameters = Type.Object({
  prompt: Type.String({
    description: '描述改成什么样。只说要改的地方，画面里其它部分照旧。用用户说话的语言写。',
  }),
  imageIds: Type.Array(Type.String(), {
    minItems: 1,
    maxItems: MAX_REFERENCES,
    description:
      '参考图的图片 id，第一张是要改的那张，产出会放在它旁边。id 来自用户引用的图、readLibrary 查到的素材，或本轮刚生成的图。',
  }),
  n: imageCountParameter,
})

function title(args: unknown): string {
  const prompt = (args as { prompt?: unknown } | null)?.prompt
  return typeof prompt === 'string' && prompt.trim()
    ? agentTitleLine(prompt, TITLE_MAX_CHARS)
    : '改图'
}

/** 第一张参考图就是被改的那张，产出贴着它放——与执行时的 `anchorObjectId` 取同一项。 */
function anchor(args: unknown): string | undefined {
  const first = (args as { imageIds?: unknown } | null)?.imageIds
  const id = Array.isArray(first) ? first[0] : undefined
  return typeof id === 'string' && id ? id : undefined
}

export const editImage: AgentToolDefinition = {
  name: 'editImage',
  guidance:
    '用户指着某张图说要改时调改图工具，参考图用他引用的那张，产出落在源图旁边，源图不动。版本数按需求用 n 指定，未要求多张时只出一张；不同修改方案分别调用。',
  title,
  outputCount: agentImageCount,
  anchor,
  // 模型可以换一个图片 id 重试，所以拿不到图不该把整轮拖垮。
  onError: 'continue',
  create(context) {
    const tool: AgentTool<typeof parameters, AgentToolDetails> = {
      name: 'editImage',
      label: '改图',
      description:
        '在已有的图上改一处，产出落到画布上源图旁边，源图不动。用户在这张图上画过遮罩时会自动只改遮罩内的部分。',
      parameters,
      async execute(_toolCallId, params, signal, onUpdate) {
        const images = await requireAgentImages(context.images, params.imageIds)
        return runQueueTask(
          context,
          {
            media: 'image',
            prompt: params.prompt,
            n: params.n,
            inputImages: images.map((image) => image.dataUrl),
            ...(images[0]?.maskDataUrl ? { mask: images[0].maskDataUrl } : {}),
            anchorObjectId: images[0]!.imageId,
          },
          signal,
          onUpdate,
        )
      },
    }
    return tool as AgentTool
  },
}
