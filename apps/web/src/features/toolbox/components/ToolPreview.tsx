import type { ReactNode } from 'react'
import type { ToolId } from '../lib/tool'

/** 目录卡片的示意图只用仓库里自带的样图，不拿用户导入的图。 */
const WALL = '/website-assets/v41/wall'
const IMAGES = {
  mug: `${WALL}/mug-1.webp`,
  watch: `${WALL}/g-product-watch.webp`,
  serum: `${WALL}/serum-macro.webp`,
  sneaker: `${WALL}/sneaker-turntable.webp`,
  perfume: `${WALL}/perfume-pedestal-up.webp`,
  ramen: `${WALL}/r26-14.webp`,
  noodle: `${WALL}/g-food-noodle.webp`,
  cake: `${WALL}/r26-15.webp`,
  town: `${WALL}/r26-28.webp`,
} as const

export const TOOL_PREVIEW_IMAGES: readonly string[] = Object.values(IMAGES)

function Sample({ src, className = '' }: { src: string; className?: string }) {
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      className={`object-cover ${className}`}
    />
  )
}

/** 图上的等宽角标：说明这件工具做了什么。 */
function Badge({ children, className }: { children: ReactNode; className: string }) {
  return (
    <span
      className={`absolute flex h-6 items-center whitespace-nowrap rounded-md bg-black/60 px-2 font-mono text-label-sm text-white backdrop-blur ${className}`}
    >
      {children}
    </span>
  )
}

const PREVIEWS: Record<ToolId, () => ReactNode> = {
  export: () => (
    <div className="absolute inset-0 flex items-end justify-center gap-3 bg-muted p-4">
      <Sample src={IMAGES.mug} className="aspect-square h-full rounded-md" />
      <Sample src={IMAGES.mug} className="aspect-square h-1/2 rounded-md" />
      <Badge className="left-2.5 top-2.5">2048 → 1024 px</Badge>
    </div>
  ),
  compress: () => (
    <>
      <Sample src={IMAGES.watch} className="absolute inset-0 h-full w-full" />
      <Badge className="left-2.5 top-2.5">1.8 MB → 412 KB</Badge>
    </>
  ),
  convert: () => (
    <>
      <div className="absolute inset-0 grid grid-cols-2">
        <Sample src={IMAGES.serum} className="h-full w-full" />
        <Sample src={IMAGES.serum} className="h-full w-full" />
      </div>
      <span className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-white" />
      <Badge className="bottom-2.5 left-2.5">PNG</Badge>
      <Badge className="bottom-2.5 right-2.5">WebP</Badge>
    </>
  ),
  crop: () => (
    <>
      <Sample src={IMAGES.sneaker} className="absolute inset-0 h-full w-full" />
      <span className="absolute left-[16%] top-[12%] grid h-[76%] w-[56%] grid-cols-3 grid-rows-3 border-2 border-white shadow-[0_0_0_999px_rgb(0_0_0/0.5)]">
        {Array.from({ length: 9 }, (_, index) => (
          <span key={index} className="border border-white/30" />
        ))}
      </span>
      <Badge className="left-2.5 top-2.5">4:5</Badge>
    </>
  ),
  rotate: () => (
    <div className="absolute inset-0 flex items-center justify-center gap-3 bg-muted p-4">
      <Sample src={IMAGES.perfume} className="aspect-square h-full rounded-lg" />
      <Sample src={IMAGES.perfume} className="aspect-square h-full -scale-x-100 rounded-lg" />
    </div>
  ),
  collage: () => (
    <div className="absolute inset-0 flex items-center justify-center bg-muted p-4">
      <div className="grid aspect-square h-full grid-cols-2 gap-1 rounded-lg bg-white p-1">
        {[IMAGES.mug, IMAGES.watch, IMAGES.serum, IMAGES.sneaker].map((src) => (
          <Sample key={src} src={src} className="h-full min-h-0 w-full rounded-sm" />
        ))}
      </div>
    </div>
  ),
  stitch: () => (
    <div className="absolute inset-0 flex items-center justify-center bg-muted p-4">
      <div className="flex aspect-[9/22] h-full flex-col overflow-hidden rounded-md">
        {[IMAGES.ramen, IMAGES.noodle, IMAGES.cake].map((src) => (
          <Sample key={src} src={src} className="min-h-0 w-full flex-1" />
        ))}
      </div>
    </div>
  ),
  slice: () => (
    <div className="absolute inset-0 grid grid-cols-3 grid-rows-3 gap-1 bg-muted p-3">
      {Array.from({ length: 9 }, (_, index) => (
        <span
          key={index}
          className="rounded-sm bg-[length:300%_300%]"
          style={{
            backgroundImage: `url(${IMAGES.town})`,
            backgroundPosition: `${(index % 3) * 50}% ${Math.floor(index / 3) * 50}%`,
          }}
        />
      ))}
    </div>
  ),
}

/** 目录卡片上那张示意图：一眼看出这件工具的效果。 */
export default function ToolPreview({ tool }: { tool: ToolId }) {
  return (
    <span className="relative block aspect-[4/3] overflow-hidden rounded-2xl bg-card">
      {PREVIEWS[tool]()}
    </span>
  )
}
