const creditsFormatter = new Intl.NumberFormat('zh-CN')

interface SubmissionCostEstimateProps {
  credits?: number
  className?: string
  blockedAction?: {
    label: string
    run(): void
  }
}

export default function SubmissionCostEstimate({
  credits,
  className = '',
  blockedAction,
}: SubmissionCostEstimateProps) {
  if (credits === undefined && !blockedAction) return null
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      {credits === undefined ? null : <span>本次 {creditsFormatter.format(credits)} 积分</span>}
      {blockedAction ? (
        <button
          type="button"
          onClick={blockedAction.run}
          className="shrink-0 font-semibold text-blue-600 underline decoration-blue-300 underline-offset-2 hover:text-blue-700 dark:text-blue-400 dark:decoration-blue-700 dark:hover:text-blue-300"
        >
          {blockedAction.label}
        </button>
      ) : null}
    </span>
  )
}
