/** Keep provider account-pool details in operator logs, outside user and agent responses. */
export function publicTaskErrorMessage(message: string): string {
  return message === 'No eligible Grok media accounts'
    ? 'Grok model channel is temporarily unavailable. Please try again later.'
    : message
}
