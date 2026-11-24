import {
  type AgentTurnSettlement,
  executeAgentTurn,
  type PreparedAgentTurn,
  type TurnRuntimePorts,
} from '../../modules/agent'
import type { RunningTurn } from '../../modules/agent/contracts'
import {
  agentToolEnd,
  agentToolStart,
  agentTurnTools,
  isAgentToolName,
} from '../../modules/agent/tools'
import { CONFIRMED_EDIT_CALL_PREFIX, confirmedMaskEditCall, toolCallStream } from './confirmed-edit'
import { directImageCall } from './direct-image'
import {
  AGENT_MASK_PROPOSAL_TOOL,
  maskProposalFailedText,
  maskProposalFromResult,
  maskProposalGuidance,
  maskProposalRetryable,
} from './mask-proposal'
import { modelHistoryTransform, saveModelHistoryAfterTurn } from './model-history'
import { createTurnAuthorization } from './turn-authorization'
import {
  clarificationChainStart,
  expandSkillInvocation,
  requestAgentReferences,
  turnInitialStateOf,
  turnModelPrompt,
  turnPromptBody,
  turnPromptText,
  turnVisualEvidence,
} from './turn-input'

export type { AgentTurnSettlement, PreparedAgentTurn }

const defaultTurnRuntimePorts: TurnRuntimePorts = {
  tools: {
    agentTurnTools,
    agentToolStart,
    agentToolEnd,
    isAgentToolName,
  },
  history: {
    modelHistoryTransform,
    saveModelHistoryAfterTurn,
  },
  turnInput: {
    createTurnAuthorization,
    clarificationChainStart,
    expandSkillInvocation,
    requestAgentReferences,
    turnInitialStateOf,
    turnModelPrompt,
    turnPromptBody,
    turnPromptText,
    turnVisualEvidence,
  },
  directEdit: {
    CONFIRMED_EDIT_CALL_PREFIX,
    directImageCall,
    confirmedMaskEditCall,
    toolCallStream,
  },
  maskProposal: {
    AGENT_MASK_PROPOSAL_TOOL,
    maskProposalFromResult,
    maskProposalGuidance,
    maskProposalRetryable,
    maskProposalFailedText,
  },
}

/** 起一轮并立刻返回把手；`read()` 可以被断开再重开。 */
export function startAgentTurn(prepared: PreparedAgentTurn): Promise<RunningTurn> {
  return executeAgentTurn(prepared, defaultTurnRuntimePorts)
}
