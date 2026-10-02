import { type ClassValue, clsx } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// 字阶 token（DESIGN.md）不是 tailwind-merge 认得的尺寸名，不登记的话 `text-body-sm` 会被当成文字色，
// 和 `text-foreground` 放在一起时被合并掉。
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['label-sm', 'body-sm', 'title', 'display'] }],
    },
  },
})

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
