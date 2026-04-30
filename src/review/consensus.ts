import { AgentVote, ConsensusResult, ReviewFinding, ExploitAttempt, DebateMessage } from '../types/review.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { emitMeshEvent } from '../dashboard/server.js';

// Role weights for consensus voting
const ROLE_WEIGHTS: Record<string, number> = {
  redteam: 4,
  security: 3,
  performance: 2,
  style: 1,
  gateway: 1,
  coder: 1,
};

export class ConsensusEngine {
  computeConsensus(
    prId: string,
    prHash: string,
    votes: AgentVote[],
    exploits: ExploitAttempt[],
    debates: DebateMessage[],
    humanVote?: { verdict: 'approve' | 'reject'; reason?: string }
  ): ConsensusResult {
    if (votes.length === 0) {
      logger.warn('No votes received — defaulting to reject for safety');
      return this.buildResult(prId, prHash, false, 0, votes, exploits, debates, []);
    }

    // Apply reputation multiplier to weights
    const weightedVotes = votes.map(v => ({
      ...v,
      weight: this.computeWeight(v),
    }));

    // Check for unmitigated critical exploits — auto-reject
    const criticalUnmitigated = exploits.filter(
      e => e.severity === 'critical' && !this.wasExploitMitigated(e.id, debates)
    );
    if (criticalUnmitigated.length > 0) {
      logger.warn('Auto-reject: unmitigated critical exploits', { count: criticalUnmitigated.length });
      emitMeshEvent('consensus-result', {
        approved: false,
        reason: `${criticalUnmitigated.length} critical unmitigated exploit(s)`,
        criticalExploits: criticalUnmitigated.map(e => e.title),
        prId,
      });
      return this.buildResult(prId, prHash, false, 0, weightedVotes, exploits, debates,
        criticalUnmitigated.map(e => ({
          id: e.id,
          category: 'exploit' as const,
          severity: 'critical' as const,
          title: e.title,
          description: e.description,
          location: e.targetLocation,
          recommendation: 'Fix before merging',
          confidence: e.confidence,
        }))
      );
    }

    // Tally weighted votes
    let approveWeight = 0;
    let rejectWeight = 0;
    let totalWeight = 0;

    for (const vote of weightedVotes) {
      totalWeight += vote.weight;
      if (vote.verdict === 'approve') {
        approveWeight += vote.weight;
      } else if (vote.verdict === 'reject') {
        rejectWeight += vote.weight;
      }
      // abstain: weight not added to either
      emitMeshEvent('consensus-vote', {
        agentRole: vote.agentRole,
        peerId: vote.agentPeerId,
        verdict: vote.verdict,
        weight: vote.weight,
        confidence: vote.confidence,
        prId,
      });
    }

    // Human advisory vote (1x weight, non-blocking)
    if (humanVote) {
      const humanWeight = 2;
      totalWeight += humanWeight;
      if (humanVote.verdict === 'approve') {
        approveWeight += humanWeight;
      } else {
        rejectWeight += humanWeight;
      }
      emitMeshEvent('consensus-vote', {
        agentRole: 'human',
        peerId: 'judge',
        verdict: humanVote.verdict,
        weight: humanWeight,
        reason: humanVote.reason,
        prId,
      });
    }

    // Confidence = approve weight / total weight in basis points
    const confidenceScore = totalWeight > 0
      ? Math.round((approveWeight / totalWeight) * 10000)
      : 0;

    const approved = confidenceScore >= config.agent.consensusThreshold;

    // Collect blocking issues
    const blockingIssues: ReviewFinding[] = votes
      .flatMap(v => v.keyFindings)
      .filter(f => ['critical', 'high'].includes(f.severity));

    const criticalFindings = blockingIssues.filter(f => f.severity === 'critical');

    logger.info('Consensus reached', {
      approved,
      confidenceScore: `${(confidenceScore / 100).toFixed(1)}%`,
      approveWeight,
      rejectWeight,
      totalWeight,
      threshold: config.agent.consensusThreshold,
    });

    emitMeshEvent('consensus-result', {
      approved,
      confidenceScore,
      approveWeight,
      rejectWeight,
      totalWeight,
      threshold: config.agent.consensusThreshold,
      blockingIssues: blockingIssues.length,
      prId,
    });

    return this.buildResult(
      prId, prHash, approved, confidenceScore,
      weightedVotes, exploits, debates, blockingIssues,
      criticalFindings
    );
  }

  private computeWeight(vote: AgentVote): number {
    const roleWeight = ROLE_WEIGHTS[vote.agentRole] ?? 1;
    // Apply reputation multiplier: ±20% for every 100 reputation points
    const repMultiplier = vote.reputationScore != null
      ? 1 + (vote.reputationScore / 500)
      : 1;
    const bounded = Math.max(0.5, Math.min(2.0, repMultiplier));
    return roleWeight * bounded;
  }

  private wasExploitMitigated(exploitId: string, debates: DebateMessage[]): boolean {
    const exploitDebates = debates.filter(d => d.requestId === exploitId);
    if (exploitDebates.length === 0) return false;
    // Check the last message in the debate chain for this exploit
    const last = exploitDebates[exploitDebates.length - 1];
    return last.mitigated === true;
  }

  private buildResult(
    prId: string,
    prHash: string,
    approved: boolean,
    confidenceScore: number,
    votes: AgentVote[],
    exploits: ExploitAttempt[],
    debates: DebateMessage[],
    blockingIssues: ReviewFinding[],
    criticalFindings: ReviewFinding[] = []
  ): ConsensusResult {
    const mitigatedExploitIds = new Set(
      debates.filter(d => d.mitigated && d.type === 'defense').map(d => d.requestId)
    );

    return {
      prId,
      prHash,
      approved,
      confidenceScore,
      totalWeight: votes.reduce((s, v) => s + v.weight, 0),
      approveWeight: votes.filter(v => v.verdict === 'approve').reduce((s, v) => s + v.weight, 0),
      rejectWeight: votes.filter(v => v.verdict === 'reject').reduce((s, v) => s + v.weight, 0),
      votes,
      criticalFindings,
      debates,
      teeProofIds: votes.map(v => v.teeProof).filter(Boolean) as string[],
      timestamp: Date.now(),
      exploitsFound: exploits,
      exploitsMitigated: exploits.filter(e => mitigatedExploitIds.has(e.id)).length,
      blockingIssues,
    };
  }
}
