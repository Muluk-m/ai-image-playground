/** 盖在画面上的小标签：镜号、首尾帧、时长。 */
export const BADGE = 'absolute rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white'

export const CHIP =
  'rounded-full border px-2.5 py-0.5 text-xs transition disabled:cursor-not-allowed disabled:opacity-40'

export const ACTIVE_CHIP = 'border-primary bg-primary/10 text-primary'

export const IDLE_CHIP =
  'border-border text-muted-foreground hover:border-primary dark:border-white/[0.12]'

/** 描述框下的运镜片段：虚线边表明它只是往描述里加文字。 */
export const SUGGESTION_CHIP =
  'rounded-full border border-dashed border-border px-2.5 py-0.5 text-xs text-muted-foreground transition hover:border-primary hover:text-primary dark:border-white/[0.16]'

export const PARAM_ROW_KEY = 'w-12 shrink-0 text-xs text-muted-foreground'

/** 盖满画框的状态层：读秒、播放键、失败原因都用它定位。 */
export const OVERLAY = 'absolute inset-0 grid place-items-center text-center text-xs'
