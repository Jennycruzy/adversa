import { ConsensusEngine } from './consensus';
import { AgentVote, DebateMessage, ExploitAttempt, ReviewFinding } from '../types/review';

const finding: ReviewFinding = {
  id: 'finding-1',
  category: 'security',
  severity: 'high',
  title: 'Missing authorization check',
  description: 'The endpoint accepts another user ID without ownership validation.',
  location: { file: 'api/users.ts', startLine: 42, endLine: 48 },
  recommendation: 'Validate ownership before returning the record.',
  confidence: 90,
};

function vote(agentRole: string, verdict: AgentVote['verdict'], keyFindings: ReviewFinding[] = []): AgentVote {
  return {
    agentPeerId: `${agentRole}-peer`,
    agentRole,
    verdict,
    confidence: 90,
    weight: 1,
    reasoning: verdict === 'approve' ? 'No blockers' : 'Blocking issues found',
    keyFindings,
  };
}

const criticalExploit: ExploitAttempt = {
  id: 'exploit-1',
  type: 'auth_bypass',
  title: 'Tenant isolation bypass',
  description: 'Changing the tenant ID returns another tenant record.',
  attackVector: 'Send a request with a different tenant ID.',
  payload: 'GET /api/users/123?tenant=other',
  targetLocation: { file: 'api/users.ts', startLine: 42, endLine: 48 },
  expectedOutcome: 'Attacker reads another tenant data.',
  severity: 'critical',
  cvssScore: 9.1,
  confidence: 95,
};

describe('ConsensusEngine', () => {
  it('approves when weighted approvals meet the configured threshold', () => {
    const result = new ConsensusEngine().computeConsensus(
      '1',
      'hash-1',
      [vote('security', 'approve'), vote('performance', 'approve'), vote('style', 'approve')],
      [],
      []
    );

    expect(result.approved).toBe(true);
    expect(result.confidenceScore).toBe(10000);
  });

  it('rejects when a critical exploit is unmitigated', () => {
    const result = new ConsensusEngine().computeConsensus(
      '1',
      'hash-1',
      [vote('security', 'approve'), vote('performance', 'approve'), vote('style', 'approve')],
      [criticalExploit],
      []
    );

    expect(result.approved).toBe(false);
    expect(result.blockingIssues[0]?.title).toBe(criticalExploit.title);
  });

  it('counts a critical exploit as mitigated when the debate ends in a defense', () => {
    const debates: DebateMessage[] = [{
      id: 'debate-1',
      requestId: criticalExploit.id,
      type: 'defense',
      fromPeer: 'security-peer',
      fromRole: 'security',
      toPeer: 'redteam-peer',
      toRole: 'redteam',
      content: 'Ownership is validated before lookup.',
      confidenceScore: 88,
      mitigated: true,
      timestamp: Date.now(),
    }];

    const result = new ConsensusEngine().computeConsensus(
      '1',
      'hash-1',
      [vote('security', 'approve'), vote('performance', 'approve'), vote('style', 'approve')],
      [criticalExploit],
      debates
    );

    expect(result.approved).toBe(true);
    expect(result.exploitsMitigated).toBe(1);
  });

  it('keeps high severity review findings as blocking issues', () => {
    const result = new ConsensusEngine().computeConsensus(
      '1',
      'hash-1',
      [vote('security', 'reject', [finding]), vote('performance', 'approve'), vote('style', 'approve')],
      [],
      []
    );

    expect(result.approved).toBe(false);
    expect(result.blockingIssues).toHaveLength(1);
    expect(result.blockingIssues[0]?.id).toBe(finding.id);
  });
});
