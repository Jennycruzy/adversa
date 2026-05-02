import { DebateMessage, ExploitAttempt } from '../types/review.js';

export interface ExploitChallengePayload {
  [key: string]: unknown;
  type: 'exploit_challenge';
  exploit: ExploitAttempt;
  request_id: string;
}

export interface DebateOutcomeSummary {
  mitigated: boolean;
  confidence: number;
  evidence: string;
}

export function buildExploitChallenge(
  exploit: ExploitAttempt,
  requestId: string
): ExploitChallengePayload {
  return {
    type: 'exploit_challenge',
    exploit,
    request_id: requestId,
  };
}

export function lastMitigationState(messages: DebateMessage[]): boolean | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const mitigated = messages[i]?.mitigated;
    if (typeof mitigated === 'boolean') return mitigated;
  }
  return undefined;
}
