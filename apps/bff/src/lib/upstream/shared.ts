/**
 * 每 channel 的上游路由风格。命中映射的 channel 用 channels.json 自带的
 * baseUrl + auth.secret（单一事实源），不走 UPSTREAM_BASE_URL 通用网关；
 * value 决定 callUpstream 走哪套上游协议。
 *
 * 不能按 model 盲查 channels：网关部署用 UPSTREAM_BASE_URL 故意把
 * openai/gemini channel 指到同一中转上游，channels.json 里它们的 baseUrl
 * 只是名义官方地址，盲查会把网关部署静默切成直连。
 */
export type ChannelRouteStyle =
  /**
   * Agnes 风格上游：没有 images/edits 端点，文生图与图生图共用
   * images/generations JSON，输入图放 extra_body.image。
   */
  | 'agnes-generations-json'
  /** 标准 OpenAI Images 语义：generations JSON / edits multipart / n>1 fan-out。 */
  | 'openai-images'
  /** Grok Imagine JSON generations/edits。1.0 多图拼 contact sheet；2.0 原生最多 5 张并映射 size/quality。 */
  | 'grok-openai-images'
  /** Grok Imagine 视频：提交拿 request_id，轮询 videos/{id}，成片字节要带 key 去内容端点取。 */
  | 'grok-videos'
  /** Agnes 视频：提交拿 video_id，轮询网关根下的 agnesapi，结果是公网 mp4 地址。 */
  | 'agnes-videos'
  /** 火山方舟 Seedance：提交 content 数组拿 id，轮询同一路径，结果是公网 mp4 地址。 */
  | 'ark-videos'
  /** Google Veo：提交拿 operation name，轮询 base + 该 name，成片要带 key 去 Google 域内取。 */
  | 'veo-videos'

export interface UpstreamCallResult {
  payload: unknown
}

/** 挂 upstreamStatus=400 → retry.ts 判为永久失败，不浪费 3 次重试。 */
export function clientError(message: string): Error {
  const err = new Error(message) as Error & { upstreamStatus: number }
  err.upstreamStatus = 400
  return err
}
