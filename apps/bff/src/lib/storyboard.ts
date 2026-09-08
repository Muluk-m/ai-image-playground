import type { StoryboardPlan, StoryboardPlanRequest } from '@image-playground/shared'
import {
  parseStoryboardPlan,
  storyboardSegments,
  storyboardShotLabel,
} from '@image-playground/shared'
import { config } from '../config'
import { askChatModel } from './chatCompletion'

export function buildStoryboardPrompt(request: StoryboardPlanRequest): string {
  const style = request.style?.trim()
  const timeline = storyboardSegments(request.totalSeconds, request.shots)
    .map((segment, index) => storyboardShotLabel(index + 1, segment))
    .join('、')
  return [
    '你是短视频分镜师。把下面这个创意拆成一条整片：整片一次生成，内部硬切成多个镜头。',
    `镜头数：恰好 ${request.shots} 个镜头，镜号 no 从 1 连续编到 ${request.shots}。`,
    `总时长：${request.totalSeconds} 秒，按 ${timeline} 切分，时间段首尾相接、不重叠。`,
    `画幅比例：${request.aspectRatio}。`,
    ...(style ? [`风格要求：${style}。`] : []),
    ...(request.referenceImage
      ? ['随附一张参考图：片中的产品 / 主体以它为准，描述与提示词都要写出它的真实外观。']
      : []),
    '只输出一个 JSON 对象，不要任何解释文字、不要前后缀。字段：',
    '"title"：分镜标题，一句话',
    '"summary"：整支片子讲什么，一到两句',
    '"videoPrompt"：整条视频的提示词，一次生成整片，按下面这个格式逐行写：',
    '  第一行：主体 + 场景 + 风格 + 光线，全片靠它保持一致，不带镜号也不带时间',
    `  之后每镜一行，写成「镜头N（a-b秒）：画面 + 运镜」，共 ${request.shots} 行，时间段照 ${timeline} 写`,
    '  行与行之间默认硬切，不要写转场说明、不要写台词标注、不要写任何解释',
    '"shots"：镜头数组，每个元素的字段：',
    '  "no"：镜号，从 1 开始的整数',
    '  "title"：镜头小标题，不超过 12 个汉字',
    '  "description"：画面内容，写清谁、在哪、做什么、光线',
    '  "camera"：运镜，如「缓慢推进」「环绕半圈」「固定机位」',
    '  "line"：这一镜的台词或字幕；没有就给空字符串',
    '  "imagePrompt"：这一镜首帧的生图提示词',
    '  "videoPrompt"：单独重出这一镜时用的图生视频提示词，写动作、运镜与光线变化',
    `"imagePrompt" 与 "videoPrompt" 都必须自成一句、不依赖上下文：一个没看过这份分镜的人把它单独粘进任意生图 / 生视频工具，也能得到这一镜。每条都要自带主体、场景、光线与风格，画幅按 ${request.aspectRatio} 描述，不要写「同上一镜」「延续前面的风格」这类指代。`,
    `创意：${request.idea.trim()}`,
  ].join('\n')
}

export function planStoryboard(request: StoryboardPlanRequest): Promise<StoryboardPlan> {
  const expected = { shots: request.shots, totalSeconds: request.totalSeconds }
  return askChatModel(
    {
      model: config.storyboard.model,
      prompt: buildStoryboardPrompt(request),
      images: request.referenceImage ? [request.referenceImage] : [],
      // 一份 5 镜脚本每镜两条提示词，外加整条视频的提示词，1500 会被截断在半句话上。
      maxTokens: 4000,
      timeoutMs: 90_000,
    },
    (value) => parseStoryboardPlan(value, expected),
  )
}
