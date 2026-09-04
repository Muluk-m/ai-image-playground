import { formatElapsed, useElapsed } from '../hooks/useElapsed'

/** 进行中的反馈：转圈加读秒。减少动效时只留文字。 */
export default function Pending({ label, startedAt }: { label: string; startedAt: number | null }) {
  const elapsed = useElapsed(startedAt)

  return (
    <span className="inline-flex items-center gap-1.5">
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:hidden"
      >
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
        />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
      </svg>
      {elapsed === null ? label : `${label} ${formatElapsed(elapsed)}`}
    </span>
  )
}
