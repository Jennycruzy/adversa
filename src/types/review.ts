export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type ReviewCategory = 'security' | 'performance' | 'style' | 'exploit';

export interface CodeLocation {
  file: string;
  startLine: number;
  endLine: number;
  snippet?: string;
}

export interface ReviewFinding {
  id: string;
  category: ReviewCategory;
  severity: Severity;
  title: string;
  description: string;
  location: CodeLocation;
  recommendation: string;
  confidence: number; // 0-100
  teeProof?: string;
  evidenceHash?: string;
  cweId?: string;
  cvssScore?: number;
}

export interface ExploitAttempt {
  id: string;
  type: 'injection' | 'race_condition' | 'auth_bypass' | 'overflow' | 'reentrancy' | 'path_traversal' | 'deserialization' | 'logic_flaw' | 'xss' | 'ssrf';
  title: string;
  description: string;
  attackVector: string;
  payload: string;
  targetLocation: CodeLocation;
  expectedOutcome: string;
  severity: Severity;
  cvssScore: number;
  confidence: number;
  teeProof?: string;
}

export interface DebateMessage {
  id: string;
  requestId: string;
  type: 'exploit_challenge' | 'defense' | 'counter_attack' | 'concession' | 'finding_challenge' | 'finding_defense';
  fromPeer: string;
  fromRole: string;
  toPeer: string;
  toRole: string;
  content: string;
  evidence?: string;
  lineReferences?: CodeLocation[];
  confidenceScore: number;
  mitigated?: boolean;
  timestamp: number;
  teeProof?: string;
}

export interface AgentVote {
  agentPeerId: string;
  agentRole: string;
  verdict: 'approve' | 'reject' | 'abstain';
  confidence: number; // 0-100
  weight: number; // role-based weight multiplier
  reasoning: string;
  keyFindings: ReviewFinding[];
  teeProof?: string;
  reputationScore?: number;
}

export interface ConsensusResult {
  prId: string;
  prHash: string;
  approved: boolean;
  confidenceScore: number; // basis points 0-10000
  totalWeight: number;
  approveWeight: number;
  rejectWeight: number;
  votes: AgentVote[];
  criticalFindings: ReviewFinding[];
  debates: DebateMessage[];
  storageRoot?: string;
  teeProofIds: string[];
  timestamp: number;
  exploitsFound: ExploitAttempt[];
  exploitsMitigated: number;
  blockingIssues: ReviewFinding[];
}

export interface PRContext {
  id: number;
  number: number;
  title: string;
  body: string;
  diff: string;
  files: PRFile[];
  author: string;
  branch: string;
  baseBranch: string;
  repoOwner: string;
  repoName: string;
  prHash: string;
  headSha: string;
  url: string;
}

export interface PRFile {
  filename: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  patch?: string;
  language?: string;
}

export interface ReviewTask {
  taskId: string;
  pr: PRContext;
  assignedTo: string;
  category: ReviewCategory;
  priority: number;
  createdAt: number;
}

export interface ReviewResult {
  taskId: string;
  agentPeerId: string;
  agentRole: string;
  findings: ReviewFinding[];
  exploits?: ExploitAttempt[];
  completedAt: number;
  teeProof?: string;
  rawResponse?: string;
}
