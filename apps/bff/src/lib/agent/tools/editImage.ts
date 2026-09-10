import type { AgentTool } from '@earendil-works/pi-agent-core'
import { agentTitleLine } from '@image-playground/shared'
import { Type } from 'typebox'
import type { ResolvedAgentImage } from '../images'
import { runQueueTask } from './queueTask'
import type { AgentToolContext, AgentToolDefinition, AgentToolDetails } from './types'

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
})

function title(args: unknown): string {
  const prompt = (args as { prompt?: unknown } | null)?.prompt
  return typeof prompt === 'string' && prompt.trim()
    ? agentTitleLine(prompt, TITLE_MAX_CHARS)
    : '改图'
}

async function resolveAll(
  context: AgentToolContext,
  imageIds: readonly string[],
): Promise<ResolvedAgentImage[]> {
  const resolved = await Promise.all(imageIds.map((id) => context.images.resolve(id)))
  return resolved.map((image, at) => {
    // 模型会顺着历史里的图片 id 猜，猜错时它得知道该让用户去输入框引用那张图。
    if (!image) throw new Error(`拿不到图片 ${imageIds[at]}，请让用户在输入框里引用它`)
    return image
  })
}

export const editImage: AgentToolDefinition = {
  name: 'editImage',
  title,
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
        const images = await resolveAll(context, params.imageIds)
        return runQueueTask(
          context,
          {
            media: 'image',
            prompt: params.prompt,
            inputImages: images.map((image) => image.dataUrl),
            ...(images[0]?.maskDataUrl ? { mask: images[0].maskDataUrl } : {}),
            anchorImageId: params.imageIds[0],
          },
          signal,
          onUpdate,
        )
      },
    }
    return tool as AgentTool
  },
}
