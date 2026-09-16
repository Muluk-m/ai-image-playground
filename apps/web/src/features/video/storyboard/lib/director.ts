import { storyboardShotLabel } from '@image-playground/shared'
import type { StoryboardContent, StoryboardRecord, StoryboardShotRecord } from '../types'

export function storyboardContent(record: StoryboardRecord): StoryboardContent {
  return structuredClone({
    title: record.title,
    summary: record.summary,
    idea: record.idea,
    aspectRatio: record.aspectRatio,
    totalSeconds: record.totalSeconds,
    videoPrompt: record.videoPrompt,
    style: record.style,
    referenceImageIds: record.referenceImageIds,
    shots: record.shots.map((shot) => ({ ...shot, videoTaskId: null })),
  })
}

export function sameStoryboard(a: StoryboardContent, b: StoryboardContent): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** 镜头编号是任务来源标识，不随排序重编号；时间段根据当前顺序重新计算。 */
export function sequenceShots(shots: StoryboardShotRecord[]): StoryboardShotRecord[] {
  let startSeconds = 0
  return shots.map((shot) => {
    const next = { ...shot, startSeconds }
    startSeconds += shot.seconds
    return next
  })
}

export function shotPrompt(shot: StoryboardShotRecord): string {
  return [shot.description, shot.camera, shot.line ? `对白：${shot.line}` : '']
    .filter(Boolean)
    .join('。')
}

export function sequencePrompt(record: StoryboardRecord, shots: StoryboardShotRecord[]): string {
  // 保留生成脚本的全局主体描述，镜头字段的编辑同步到实际提交的提示词。
  const opening = record.videoPrompt.split(/\n?镜头\s*\d+[（(]/)[0]?.trim() || record.summary
  return [
    opening,
    ...shots.map((shot, i) => `${storyboardShotLabel(i + 1, shot)}：${shot.videoPrompt}`),
  ]
    .filter(Boolean)
    .join('\n')
}

/** 只重排提示词中的镜头时间标记，保留用户编辑的描述和原分镜。 */
export function promptAtDuration(prompt: string, sourceSeconds: number, seconds: number): string {
  if (!prompt.trim() || seconds === sourceSeconds || sourceSeconds <= 0) return prompt
  const scale = (value: string) => Math.round((Number(value) * seconds * 100) / sourceSeconds) / 100
  const retimed = prompt.replace(
    /(镜头\s*\d+[（(])(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)(\s*秒[）)])/g,
    (_, prefix: string, start: string, end: string, suffix: string) =>
      `${prefix}${scale(start)}-${scale(end)}${suffix}`,
  )
  return `视频总时长为 ${seconds} 秒，按此时长完整呈现以下内容。\n${retimed}`
}
