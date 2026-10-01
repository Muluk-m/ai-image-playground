import type { AgentMediaReference, AgentVisualEvidence } from './agent'

export type AnalysisIntent = 'inspection' | 'joint_comparison'

export interface AnalysisInputSnapshot {
  /** Absent on older tasks, which are individual inspections. */
  readonly intent?: AnalysisIntent
  readonly model: string
  readonly prompt: string
  readonly inputs: readonly AgentMediaReference[]
  readonly estimatedInputTokens: number
  readonly evidence: readonly AgentVisualEvidence[]
  /** Numbered visual blocks and immutable selection geometry used in the request. */
  readonly visualManifest?: string
}

export interface AnalysisFinding {
  readonly imageId: string
  readonly text: string
}

export interface AnalysisComparison {
  readonly status: 'completed'
  readonly imageIds: readonly string[]
  readonly text: string
}

export interface AnalysisCoverage {
  /** Separate relational result; individual image findings do not establish joint completion. */
  readonly comparison?: AnalysisComparison
  readonly requiredImageIds: readonly string[]
  readonly reviewedImageIds: readonly string[]
  readonly missingImageIds: readonly string[]
}
