/**
 * chip-mode 专用 icon 集：统一 1.6 stroke + 16px，跟 icons.tsx 的 2.0 stroke 通用集
 * 区分开。仅 chip 模式 InputBar 使用。
 */

const CHIP_ICON_CLASS = 'h-4 w-4'

export const ChipIcons = {
  model: (
    <svg
      className={CHIP_ICON_CLASS}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      viewBox="0 0 24 24"
    >
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="18" x2="20" y2="18" />
      <circle cx="9" cy="6" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="16" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="11" cy="18" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  ),
  size: (
    <svg
      className={CHIP_ICON_CLASS}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
    >
      <path d="M4 9V5a1 1 0 011-1h4M20 9V5a1 1 0 00-1-1h-4M4 15v4a1 1 0 001 1h4M20 15v4a1 1 0 01-1 1h-4" />
    </svg>
  ),
  aspect: (
    <svg
      className={CHIP_ICON_CLASS}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinejoin="round"
      viewBox="0 0 24 24"
    >
      <rect x="3" y="7" width="18" height="10" rx="1.5" />
      <line x1="9" y1="7" x2="9" y2="17" />
    </svg>
  ),
  imageSize: (
    <svg
      className={CHIP_ICON_CLASS}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
    >
      <path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />
    </svg>
  ),
  thinking: (
    <svg
      className={CHIP_ICON_CLASS}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinejoin="round"
      viewBox="0 0 24 24"
    >
      <path d="M11 4l1.6 4.4L17 10l-4.4 1.6L11 16l-1.6-4.4L5 10l4.4-1.6L11 4z" />
      <path d="M18 14l.8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8L18 14z" />
    </svg>
  ),
  quality: (
    <svg
      className={CHIP_ICON_CLASS}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinejoin="round"
      viewBox="0 0 24 24"
    >
      <path d="M13 3L5 14h6l-1 7 9-12h-6l1-6z" />
    </svg>
  ),
  format: (
    <svg
      className={CHIP_ICON_CLASS}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
    >
      <path d="M14 3H6.5A1.5 1.5 0 005 4.5v15A1.5 1.5 0 006.5 21h11a1.5 1.5 0 001.5-1.5V8l-5-5z" />
      <path d="M14 3v4a1 1 0 001 1h4" />
    </svg>
  ),
  compression: (
    <svg
      className={CHIP_ICON_CLASS}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
    >
      <path d="M9 4v3a2 2 0 01-2 2H4M15 4v3a2 2 0 002 2h3M9 20v-3a2 2 0 00-2-2H4M15 20v-3a2 2 0 012-2h3" />
    </svg>
  ),
  noRewrite: (
    <svg
      className={CHIP_ICON_CLASS}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
    >
      <path d="M17 3l4 4-11 11H6v-4L17 3z" />
      <line x1="4" y1="21" x2="21" y2="4" />
    </svg>
  ),
  moderation: (
    <svg
      className={CHIP_ICON_CLASS}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
    >
      <path d="M12 3l8 3v6c0 4.5-3.5 8-8 9-4.5-1-8-4.5-8-9V6l8-3z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  ),
  count: (
    <svg
      className={CHIP_ICON_CLASS}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      viewBox="0 0 24 24"
    >
      <line x1="10" y1="4" x2="8" y2="20" />
      <line x1="16" y1="4" x2="14" y2="20" />
      <line x1="4" y1="10" x2="20" y2="10" />
      <line x1="4" y1="16" x2="20" y2="16" />
    </svg>
  ),
  imageAttach: (
    <svg className="h-[18px] w-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <rect x="3.5" y="5" width="17" height="14" rx="2" strokeWidth={1.6} />
      <circle cx="9" cy="10.5" r="1.6" strokeWidth={1.6} />
      <path
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M20.5 16.5L15.7 11.8a1 1 0 00-1.4 0L5.5 20.5"
      />
    </svg>
  ),
  sparkles: (
    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.75}
        d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3zM19 14l.7 2.1L22 17l-2.3.9L19 20l-.7-2.1L16 17l2.3-.9L19 14z"
      />
    </svg>
  ),
  enterKey: (
    <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M9 10l-4 4 4 4M20 4v6a4 4 0 01-4 4H5"
      />
    </svg>
  ),
}
