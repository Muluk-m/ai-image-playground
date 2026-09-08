import type { StoryboardPlan, StoryboardPlanRequest } from '@image-playground/shared'
import { parseStoryboardPlan } from '@image-playground/shared'
import { config } from '../config'
import { askChatModel } from './chatCompletion'

export function buildStoryboardPrompt(request: StoryboardPlanRequest): string {
  const style = request.style?.trim()
  return [
    '你是短视频分镜师。把下面这个创意拆成一份可以直接开拍的分镜脚本。',
    `镜头数：恰好 ${request.shots} 个镜头，镜号 no 从 1 连续编到 ${request.shots}。`,
    `每镜时长：${request.secondsPerShot} 秒。`,
    `画幅比例：${request.aspectRatio}。`,
    ...(style ? [`风格要求：${style}。`] : []),
    ...(request.referenceImage
      ? ['随附一张参考图：片中的产品 / 主体以它为准，描述与提示词都要写出它的真实外观。']
      : []),
    '只输出一个 JSON 对象，不要任何解释文字、不要前后缀。字段：',
    '"title"：分镜标题，一句话',
    '"summary"：整支片子讲什么，一到两句',
    '"shots"：镜头数组，每个元素的字段：',
    '  "no"：镜号，从 1 开始的整数',
    '  "title"：镜头小标题，不超过 12 个汉字',
    '  "description"：画面内容，写清谁、在哪、做什么、光线',
    '  "camera"：运镜，如「缓慢推进」「环绕半圈」「固定机位」',
    '  "line"：这一镜的台词或字幕；没有就给空字符串',
    `  "seconds"：${request.secondsPerShot}`,
    '  "imagePrompt"：这一镜首帧的生图提示词',
    '  "videoPrompt"：这一镜的图生视频提示词，写动作、运镜与光线变化',
    `"imagePrompt" 与 "videoPrompt" 都必须自成一句、不依赖上下文：一个没看过这份分镜的人把它单独粘进任意生图 / 生视频工具，也能得到这一镜。每条都要自带主体、场景、光线与风格，画幅按 ${request.aspectRatio} 描述，不要写「同上一镜」「延续前面的风格」这类指代。`,
    `创意：${request.idea.trim()}`,
  ].join('\n')
}

export function planStoryboard(request: StoryboardPlanRequest): Promise<StoryboardPlan> {
  const expected = { shots: request.shots, seconds: request.secondsPerShot }
  return askChatModel(
    {
      model: config.storyboard.model,
      prompt: buildStoryboardPrompt(request),
      images: request.referenceImage ? [request.referenceImage] : [],
      // 一份 6 镜脚本每镜两条提示词，1500 会被截断在半句话上。
      maxTokens: 4000,
      timeoutMs: 90_000,
    },
    (value) => parseStoryboardPlan(value, expected),
  )
}
