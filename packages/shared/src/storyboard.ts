/**
 * 旧导演台的分镜只剩浏览器本地的旧记录，升级旧记录时还要用镜头行首拼整条视频提示词。
 */
export interface StoryboardSegment {
  readonly startSeconds: number
  readonly seconds: number
}

/** 时间段标签的数字部分，如 `0-3.5`。 */
export function storyboardRangeLabel(segment: StoryboardSegment): string {
  return `${segment.startSeconds}-${segment.startSeconds + segment.seconds}`
}

/** 整条视频提示词里每镜那一行的行首，模型照它写，旧记录也照它补。 */
export function storyboardShotLabel(no: number, segment: StoryboardSegment): string {
  return `镜头${no}（${storyboardRangeLabel(segment)}秒）`
}
