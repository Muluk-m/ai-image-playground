import { isModelUnavailableRejection } from '@image-playground/shared'

/** Keep provider account-pool details in operator logs, outside user and agent responses. */
export function publicTaskErrorMessage(message: string): string {
  return isModelUnavailableRejection({ message })
    ? 'This model is temporarily unavailable. Please choose another model.'
    : message
}
