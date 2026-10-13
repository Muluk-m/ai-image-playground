import type { PrivateSubmissionBlockedAction } from '../lib/privateOverlay'
import { Button } from './ui/button'

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
    <Button
      variant="link"
      size="xs"
      type="button"
      onClick={blockedAction.run}
      className={`h-auto shrink-0 whitespace-normal p-0 font-semibold underline ${className}`}
    >
      {blockedAction.label}
    </Button>
  )
}
