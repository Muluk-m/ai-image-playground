import {
  Ban,
  Bookmark,
  Brush,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  Clock3,
  Code,
  Copy,
  CornerUpLeft,
  Download,
  FolderOpen,
  Image,
  Images,
  ImageUp,
  LayoutGrid,
  Link,
  LoaderCircle,
  type LucideIcon,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  Square,
  Star,
  Trash2,
  X,
} from 'lucide-react'

import { cn } from '@/lib/utils'

// 只登记已经在用的语义名：迁移到哪个文件、弄清那个图标的含义，再加名字。
export const ICONS = {
  // 通用操作
  add: Plus,
  close: X,
  check: Check,
  delete: Trash2,
  copy: Copy,
  edit: Pencil,
  reuse: CornerUpLeft,
  link: Link,
  code: Code,
  download: Download,
  attach: Paperclip,
  refresh: RefreshCw,
  loading: LoaderCircle,
  // 方向
  chevronUp: ChevronUp,
  chevronDown: ChevronDown,
  chevronLeft: ChevronLeft,
  chevronRight: ChevronRight,
  // 导航与收藏
  folderOpen: FolderOpen,
  assets: LayoutGrid,
  bookmark: Bookmark,
  favorite: Star,
  // 创作与媒体
  sparkles: Sparkles,
  image: Image,
  images: Images,
  sendToCanvas: ImageUp,
  brush: Brush,
  stop: Square,
  // 状态
  error: CircleAlert,
  blocked: Ban,
  clock: Clock3,
} satisfies Record<string, LucideIcon>

export type IconName = keyof typeof ICONS

/** 四档尺寸，见 DESIGN.md「图标」：28px 控件配 xs，32–36px 配 sm。 */
export const ICON_SIZE_PX = { xs: 14, sm: 16, md: 20, lg: 24 } as const
export type IconSize = keyof typeof ICON_SIZE_PX

/** 所有尺寸下视觉线宽都是 1.5px（absoluteStrokeWidth）。 */
const STROKE_WIDTH = 1.5

export interface IconProps {
  name: IconName
  size?: IconSize
  className?: string
  /** 图标单独表达含义时给读屏的名字；装饰性图标不传。 */
  label?: string
  /** 实心只给选中态（已收藏、已选中），其余一律描线。 */
  filled?: boolean
}

export function Icon({ name, size = 'sm', className, label, filled = false }: IconProps) {
  const Glyph = ICONS[name]
  return (
    <Glyph
      size={ICON_SIZE_PX[size]}
      strokeWidth={STROKE_WIDTH}
      absoluteStrokeWidth
      fill={filled ? 'currentColor' : 'none'}
      className={cn('shrink-0', className)}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    />
  )
}
