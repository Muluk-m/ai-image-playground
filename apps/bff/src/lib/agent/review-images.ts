import type { AgentImageSource, ResolvedAgentImage } from './images'
import { AgentToolError } from './tools/errors'
import { assertVisualBytes, visualByteLimit } from './visual-resources'

/** 复核这一轮实际随输入附上的产物，以及因图片预算没能附上的那几张。 */
export interface PreparedReviewImages {
  readonly reviewed: ResolvedAgentImage[]
  readonly omitted: string[]
}

const imageBytes = (image: ResolvedAgentImage) =>
  Buffer.byteLength(image.dataUrl, 'utf8') + Buffer.byteLength(image.maskDataUrl ?? '', 'utf8')

/**
 * 读出复核要看的产物。
 *
 * 复核只是判断「出来的图对不对」，用预览（长边 ≤1024 的 webp）就够；原件（一张 4K 无损产物
 * 就是 20MB 上下的 base64）留给输出与后续改图，不进这一轮的请求。即使预览也装不下，
 * 这一轮照常跑完：没附上的产物列进 `omitted`，由提示词让模型如实说没看到，而不是整轮失败。
 * 读不出来的必需复核图仍然报错——缺图不能算复核过。
 */
export async function prepareReviewImages(
  images: Pick<AgentImageSource, 'resolve'>,
  references: readonly ResolvedAgentImage[],
  required: readonly string[],
  optional: readonly string[] = [],
): Promise<PreparedReviewImages> {
  let preparedBytes = references.reduce((sum, image) => sum + imageBytes(image), 0)
  // 本轮附图是用户的请求本身，装不下时照旧明确报告。
  assertVisualBytes(preparedBytes)
  const byteLimit = visualByteLimit()
  // 几张预览并行读，再按原顺序记预算。每次读取各自去拿 `agent:visual-prepare-concurrency` 名额
  //（图源内部拿），这里不把整批包进一个名额，否则批内的读取会绕过全局的内存保护。
  const reads = [
    ...required.map((id, index) => ({
      kind: 'required' as const,
      index,
      work: () => images.resolve(id, 'preview'),
    })),
    ...optional.map((id, index) => ({
      kind: 'optional' as const,
      index,
      work: () => images.resolve(id, 'preview').catch(() => null),
    })),
  ]
  const results = await mapSettledBounded(reads, (read) => read.work())
  const requiredImages: Array<ResolvedAgentImage | null> = new Array(required.length).fill(null)
  const optionalImages: Array<ResolvedAgentImage | null> = new Array(optional.length).fill(null)
  for (const [index, read] of reads.entries()) {
    const result = results[index]!
    if (result.status === 'rejected') {
      if (read.kind === 'required') throw result.reason
      continue
    }
    if (read.kind === 'required') requiredImages[read.index] = result.value
    else optionalImages[read.index] = result.value
  }
  const reviewed: ResolvedAgentImage[] = []
  const omitted: string[] = []
  for (const [index, id] of required.entries()) {
    const image = requiredImages[index]
    if (!image)
      throw new AgentToolError(
        'invalid_params',
        `复核图片 ${id} 无法读取，联合复核未完成。请重新添加有效图片或选择需要复核的范围。`,
      )
    if (preparedBytes + imageBytes(image) > byteLimit) {
      omitted.push(id)
      continue
    }
    preparedBytes += imageBytes(image)
    reviewed.push(image)
  }
  // 批次唤醒的复核图尽力附带：旧产物可能已删、几批同时完成可能超预算，跳过即可，
  // 唤醒说明让模型以图片清单为准，没附上的如实说未查看。
  for (const image of optionalImages) {
    if (!image || preparedBytes + imageBytes(image) > byteLimit) continue
    preparedBytes += imageBytes(image)
    reviewed.push(image)
  }
  return { reviewed, omitted }
}

/** 复核图同时读取的上限。 */
export const REVIEW_READ_PARALLELISM = 4

/** 按顺序返回 settled 结果的有界并发 map；失败也要等其它已启动读取结束后才向外抛。 */
async function mapSettledBounded<T, R>(
  items: readonly T[],
  work: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length)
  let next = 0
  const lane = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await Promise.resolve()
        .then(() => work(items[index]!))
        .then(
          (value) => ({ status: 'fulfilled' as const, value }),
          (reason) => ({ status: 'rejected' as const, reason }),
        )
    }
  }
  await Promise.all(Array.from({ length: Math.min(REVIEW_READ_PARALLELISM, items.length) }, lane))
  return results
}

/** 必需复核图没附上时追加给模型的说明；都附上了就是空串。 */
export function omittedReviewNote(omitted: readonly string[]): string {
  if (omitted.length === 0) return ''
  return `\n\n【复核说明】以下产物因图片预算未能附上，本轮没有看到它们：${omitted.join('、')}。请如实告诉用户这几张未查看，不要声称已复核；需要时用 viewImage 分别查看。`
}
