import { ConsensusResult } from '../types/review.js';

export interface ReviewGuardrailDecision {
  allowed: boolean;
  reason?: string;
}

export function enforceAutoMergeGuardrails(consensus: ConsensusResult): ReviewGuardrailDecision {
  if (!consensus.approved) {
    return { allowed: false, reason: 'Consensus rejected the pull request' };
  }

  if (consensus.blockingIssues.length > 0) {
    return { allowed: false, reason: 'Consensus still contains blocking issues' };
  }

  const unmitigatedCritical = consensus.exploitsFound.some(exploit =>
    exploit.severity === 'critical'
  ) && consensus.exploitsMitigated < consensus.exploitsFound.length;

  if (unmitigatedCritical) {
    return { allowed: false, reason: 'Unmitigated critical exploit remains' };
  }

  return { allowed: true };
}
