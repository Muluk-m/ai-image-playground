import type { PrivateSubmissionBlockedAction } from '../lib/privateOverlay'

interface SubmissionBillingActionProps {
  className?: string
  blockedAction?: PrivateSubmissionBlockedAction
}

export default function SubmissionBillingAction({
  className = '',
  blockedAction,
}: SubmissionBillingActionProps) {
  if (!blockedAction) return null
  return (
    <button
      type="button"
      onClick={blockedAction.run}
      className={`shrink-0 font-semibold text-blue-600 underline decoration-blue-300 underline-offset-2 hover:text-blue-700 dark:text-blue-400 dark:decoration-blue-700 dark:hover:text-blue-300 ${className}`}
    >
      {blockedAction.label}
    </button>
  )
}
