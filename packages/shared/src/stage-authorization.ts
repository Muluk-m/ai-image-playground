export type StageAuthorizationStatus = 'pending' | 'active' | 'exhausted' | 'ended'

export interface StageAuthorizationAttempt {
  readonly id: string
  readonly nodeId: string
  readonly model: string
  readonly quantity: number
  readonly unitMultiplier: number
  readonly reservedCredits: number
  readonly spentCredits: number
  readonly submittedQuantity: number
  readonly taskIds: readonly string[]
}
export interface StageAuthorizationAudit {
  readonly at: number
  readonly kind: 'proposed' | 'confirmed' | 'preflight' | 'submitted' | 'exhausted' | 'ended'
  readonly nodeId?: string
  readonly taskId?: string
  readonly credits?: number
}
export interface StageAuthorization {
  readonly id: string
  readonly conversationId: string
  readonly projectId: string
  readonly stage: string
  readonly nodeIds: readonly string[]
  readonly nodeNames: readonly string[]
  readonly estimatedCredits: number
  readonly budgetCap: number
  readonly spentCredits: number
  readonly status: StageAuthorizationStatus
  readonly attempts: readonly StageAuthorizationAttempt[]
  readonly audit: readonly StageAuthorizationAudit[]
}
/** Ephemeral execution credential; never store it in a canvas, message, or browser storage. */
export interface StageAuthorizationSubmission {
  readonly authorizationId: string
  readonly nodeId: string
  readonly attemptId: string
  readonly executionToken: string
}
export interface StageAuthorizationPreflight {
  readonly nodeId: string
  readonly attemptId: string
  readonly executionToken: string
  readonly model: string
  readonly quantity: number
  readonly unitMultiplier: number
}
