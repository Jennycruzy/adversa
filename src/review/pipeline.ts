import { AXLClient } from '../axl/client.js';
import { TopologyManager } from '../axl/topology.js';
import { GossipSub, GOSSIP_TOPICS } from '../axl/gossipsub.js';
import { ConsensusEngine } from './consensus.js';
import { GitHubClient } from '../integrations/github.js';
import { OGStorageClient } from '../integrations/og-storage.js';
import { OGChainClient } from '../integrations/og-chain.js';
import { KeeperHubClient } from '../integrations/keeperhub.js';
import { SyncEngine } from '../offline/sync.js';
import { globalTEERegistry } from '../integrations/og-tee-attestation.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { emitMeshEvent } from '../dashboard/server.js';
import {
  PRContext,
  ReviewFinding,
  ExploitAttempt,
  AgentVote,
  DebateMessage,
  ConsensusResult,
} from '../types/review.js';
import { PeerInfo } from '../types/agent.js';

export interface PipelineResult {
  consensus: ConsensusResult;
  txHash?: string;
  storageRoot?: string;
  githubAction: 'merged' | 'rejected' | 'pending_human';
}

export class ReviewPipeline {
  private consensus = new ConsensusEngine();
  private github: GitHubClient;
  private storage: OGStorageClient;
  private chain: OGChainClient;
  private keeperhub: KeeperHubClient;

  // Track which PRs are awaiting human review
  private humanPendingPRs: Map<string, NodeJS.Timeout> = new Map();
  private humanVotes: Map<string, { verdict: 'approve' | 'reject'; reason?: string }> = new Map();

  constructor(
    private readonly axl: AXLClient,
    private readonly topology: TopologyManager,
    private readonly gossip: GossipSub,
    private readonly syncEngine: SyncEngine
  ) {
    this.github = new GitHubClient();
    this.storage = new OGStorageClient();
    this.chain = new OGChainClient();
    this.keeperhub = new KeeperHubClient();
  }

  async initialize(): Promise<void> {
    await Promise.all([
      this.storage.initialize(),
      this.chain.initialize(),
      this.keeperhub.initialize(),
    ]);

    // Register sync executors
    this.syncEngine.registerExecutor('github-merge', async action => {
      const { owner, repo, prNumber, commitMessage } = action.payload;
      await this.github.mergePR(String(owner), String(repo), Number(prNumber), String(commitMessage));
    });

    this.syncEngine.registerExecutor('og-storage-upload', async action => {
      await this.storage.upload(action.payload);
    });

    this.syncEngine.registerExecutor('og-chain-record-review', async action => {
      const consensus = action.payload['consensus'] as ConsensusResult;
      const storageRoot = action.payload['storageRoot'] as string;
      if (config.og.registryAddress) {
        await this.chain.recordReview(consensus, storageRoot);
      }
    });

    this.syncEngine.registerExecutor('keeperhub-workflow', async action => {
      await this.keeperhub.recordReviewOnChain(
        action.payload['consensus'] as ConsensusResult,
        action.payload['storageRoot'] as string,
        String(action.payload['registryAddress'])
      );
    });

    // Listen for human votes
    this.gossip.subscribe(GOSSIP_TOPICS.HUMAN_ACTIVITY, (from, data) => {
      const d = data as { type?: string; verdict?: 'approve' | 'reject'; prHash?: string; reason?: string };
      if (d.type === 'human-vote' && d.prHash && d.verdict) {
        this.humanVotes.set(d.prHash, { verdict: d.verdict, reason: d.reason });
        // Clear the human-pending timeout so we resume immediately
        const timeout = this.humanPendingPRs.get(d.prHash);
        if (timeout) {
          clearTimeout(timeout);
          this.humanPendingPRs.delete(d.prHash);
        }
        logger.info('Human vote received', { prHash: d.prHash, verdict: d.verdict });
      }
    });

    logger.info('Review pipeline initialized');
  }

  // ─── PHASE 0-6 ORCHESTRATION ─────────────────────────────────────────────────

  async run(pr: PRContext): Promise<PipelineResult> {
    const { prHash } = pr;
    logger.info('Pipeline starting', { prNumber: pr.number, prHash: prHash.slice(0, 12) });

    emitMeshEvent('pipeline-start', { prNumber: pr.number, prHash, prTitle: pr.title, phase: 0 });

    // ─── Phase 1: Topology discovery ──────────────────────────────────────────
    await this.topology.refresh();
    const onlinePeers = this.topology.getOnlinePeers();
    emitMeshEvent('pipeline-phase', { phase: 1, name: 'topology', peers: onlinePeers.length, prHash });

    const securityPeers = this.topology.getPeersByRole('security');
    const performancePeers = this.topology.getPeersByRole('performance');
    const stylePeers = this.topology.getPeersByRole('style');
    const redteamPeers = this.topology.getPeersByRole('redteam');

    logger.info('Online agents discovered', {
      security: securityPeers.length,
      performance: performancePeers.length,
      style: stylePeers.length,
      redteam: redteamPeers.length,
    });

    // ─── Phase 2: Fan-out via MCP (parallel) ─────────────────────────────────
    emitMeshEvent('pipeline-phase', { phase: 2, name: 'fan-out', prHash });

    const mcpPayload = {
      diff: pr.diff,
      files: pr.files.map(f => f.filename),
      context: {
        id: pr.id,
        number: pr.number,
        title: pr.title,
        author: pr.author,
        prHash,
      },
    };

    const [securityResults, perfResults, styleResults] = await Promise.allSettled([
      this.callMCPAgent(securityPeers[0], 'security-scan', mcpPayload),
      this.callMCPAgent(performancePeers[0], 'perf-analysis', mcpPayload),
      this.callMCPAgent(stylePeers[0], 'style-check', mcpPayload),
    ]);

    const secFindings = this.extractFindings(securityResults);
    const perfFindings = this.extractFindings(perfResults);
    const styleFindings = this.extractFindings(styleResults);
    const allFindings = [...secFindings, ...perfFindings, ...styleFindings];

    logger.info('Fan-out complete', {
      security: secFindings.length,
      performance: perfFindings.length,
      style: styleFindings.length,
    });
    emitMeshEvent('pipeline-phase', {
      phase: 2,
      name: 'fan-out-complete',
      secFindings: secFindings.length,
      perfFindings: perfFindings.length,
      styleFindings: styleFindings.length,
      prHash,
    });

    // ─── Phase 3: Red-team adversarial exploit scan ────────────────────────────
    emitMeshEvent('pipeline-phase', { phase: 3, name: 'redteam', prHash });

    let exploits: ExploitAttempt[] = [];
    let allDebates: DebateMessage[] = [];

    if (redteamPeers[0] && securityPeers[0]) {
      try {
        const redteamResult = await this.axl.callMCP(
          redteamPeers[0].peerId,
          'exploit-scan',
          'exploit-scan',
          {
            ...mcpPayload,
            securityFindings: secFindings,
            targetPeerId: securityPeers[0].peerId,
          }
        ) as {
          exploits?: ExploitAttempt[];
          debateOutcomes?: Array<{ exploit: ExploitAttempt; mitigated: boolean; debateMessages: DebateMessage[] }>;
        };

        exploits = redteamResult.exploits ?? [];
        allDebates = (redteamResult.debateOutcomes ?? []).flatMap(o => o.debateMessages);

        logger.info('Red-team scan complete', {
          exploits: exploits.length,
          debates: allDebates.length,
        });
      } catch (err) {
        logger.warn('Red-team scan failed', { err });
      }
    }

    // ─── Phase 4: Human presence detection ────────────────────────────────────
    emitMeshEvent('pipeline-phase', { phase: 4, name: 'guardrails', prHash });
    const humanVote = this.humanVotes.get(prHash);
    if (humanVote) {
      logger.info('Human vote already present for PR', { prHash, verdict: humanVote.verdict });
      emitMeshEvent('human-detected', { prHash, verdict: humanVote.verdict, source: 'cached' });
    }

    // ─── Phase 5: Consensus via convergecast ─────────────────────────────────
    emitMeshEvent('pipeline-phase', { phase: 5, name: 'consensus', prHash });

    const votes: AgentVote[] = [];

    // Build votes from findings
    if (securityPeers[0]) {
      votes.push(this.buildVote(securityPeers[0], secFindings, 'security'));
    }
    if (performancePeers[0]) {
      votes.push(this.buildVote(performancePeers[0], perfFindings, 'performance'));
    }
    if (stylePeers[0]) {
      votes.push(this.buildVote(stylePeers[0], styleFindings, 'style'));
    }
    if (redteamPeers[0]) {
      const unmitigated = exploits.filter(e =>
        !allDebates.some(d => d.requestId === e.id && d.mitigated)
      );
      votes.push({
        agentPeerId: redteamPeers[0].peerId,
        agentRole: 'redteam',
        verdict: unmitigated.some(e => ['critical', 'high'].includes(e.severity)) ? 'reject' : 'approve',
        confidence: 85,
        weight: 4,
        reasoning: `Found ${exploits.length} exploits, ${unmitigated.length} unmitigated`,
        keyFindings: unmitigated.map(e => ({
          id: e.id,
          category: 'exploit' as const,
          severity: e.severity,
          title: e.title,
          description: e.description,
          location: e.targetLocation,
          recommendation: 'Fix before merging',
          confidence: e.confidence,
          cvssScore: e.cvssScore,
        })),
      });
    }

    // Collect votes via convergecast if multiple agents
    if (votes.length > 1) {
      try {
        await this.axl.convergecast(
          `adversa:votes:${prHash}`,
          { votes: votes as unknown as Record<string, unknown>[] },
          'collect'
        );
      } catch {
        logger.debug('Convergecast failed, using direct votes');
      }
    }

    const consensusResult = this.consensus.computeConsensus(
      String(pr.id), prHash, votes, exploits, allDebates, humanVote
    );

    // ─── Phase 6: Action + on-chain recording ─────────────────────────────────
    emitMeshEvent('pipeline-phase', { phase: 6, name: 'action', approved: consensusResult.approved, prHash });

    // Collect all TEE attestation data gathered during this review
    const teeAttestation = globalTEERegistry.toJSON();
    emitMeshEvent('tee-attestation', {
      prHash,
      ...globalTEERegistry.summary(),
      providers: (teeAttestation as { providers: unknown[] }).providers,
    });

    const storageUpload = await this.storage.uploadReviewFindings({
      prHash,
      findings: allFindings,
      votes,
      consensus: consensusResult,
      teeProofs: consensusResult.teeProofIds,
      teeAttestation,
    });
    consensusResult.storageRoot = storageUpload.rootHash;

    // Also upload debate transcript
    if (allDebates.length > 0) {
      await this.storage.uploadDebateTranscript({
        prHash,
        messages: allDebates,
        startTime: pr.id,
        endTime: Date.now(),
        participants: votes.map(v => v.agentPeerId),
      });
    }

    let githubAction: PipelineResult['githubAction'] = 'pending_human';
    let txHash: string | undefined;

    const commitSha = pr.files[0] ? pr.prHash : 'HEAD';

    if (consensusResult.approved) {
      // Merge the PR
      const mergeMsg = [
        `Merged by ADVERSA (confidence: ${(consensusResult.confidenceScore / 100).toFixed(1)}%)`,
        `Exploits found: ${exploits.length}, mitigated: ${consensusResult.exploitsMitigated}`,
        `Storage: ${storageUpload.rootHash}`,
      ].join('\n');

      const mergeResult = await this.syncEngine.executeOrQueue('github-merge', {
        owner: pr.repoOwner,
        repo: pr.repoName,
        prNumber: pr.number,
        commitMessage: mergeMsg,
      });

      githubAction = 'merged';
      emitMeshEvent('github-action', { action: 'merged', prNumber: pr.number, queued: mergeResult === 'queued', prHash });
    } else {
      // Request changes with inline comments
      await this.github.requestChanges(
        pr.repoOwner,
        pr.repoName,
        pr.number,
        commitSha,
        consensusResult.blockingIssues,
        `ADVERSA Review: ${consensusResult.blockingIssues.length} blocking issue(s) found. ` +
        `Confidence: ${(consensusResult.confidenceScore / 100).toFixed(1)}%. ` +
        `Exploits: ${exploits.length} found, ${consensusResult.exploitsMitigated} mitigated.`
      );
      githubAction = 'rejected';
      emitMeshEvent('github-action', { action: 'rejected', prNumber: pr.number, prHash });
    }

    // Record directly on 0G Chain via AdversaRegistry contract
    if (config.og.registryAddress) {
      const realTxHash = await this.chain.recordReview(consensusResult, storageUpload.rootHash);
      if (realTxHash) {
        txHash = realTxHash;
        emitMeshEvent('chain-tx', { action: 'review-recorded', txHash: realTxHash, prHash, approved: consensusResult.approved });
        logger.info('Review recorded on 0G Chain', { txHash: realTxHash, prHash: prHash.slice(0, 12) });
      }
    }

    logger.info('Pipeline complete', {
      prNumber: pr.number,
      approved: consensusResult.approved,
      confidence: `${(consensusResult.confidenceScore / 100).toFixed(1)}%`,
      githubAction,
      txHash,
    });

    return { consensus: consensusResult, txHash, storageRoot: storageUpload.rootHash, githubAction };
  }

  // ─── Helper methods ───────────────────────────────────────────────────────────

  private async callMCPAgent(
    peer: PeerInfo | undefined,
    service: string,
    params: Record<string, unknown>
  ): Promise<ReviewFinding[]> {
    if (!peer) {
      logger.warn(`No ${service} agent online — skipping`);
      return [];
    }

    emitMeshEvent('mcp-call', { from: 'gateway', to: peer.peerId, toRole: peer.role, service });

    const result = await this.axl.callMCP(peer.peerId, service, service, params) as {
      findings?: ReviewFinding[];
    };

    return result.findings ?? [];
  }

  private extractFindings(settled: PromiseSettledResult<ReviewFinding[]>): ReviewFinding[] {
    if (settled.status === 'fulfilled') return settled.value;
    logger.warn('Agent MCP call failed', { reason: settled.reason });
    return [];
  }

  private buildVote(peer: PeerInfo, findings: ReviewFinding[], role: string): AgentVote {
    const blocking = findings.filter(f => ['critical', 'high'].includes(f.severity));
    const verdict: AgentVote['verdict'] = blocking.length > 0 ? 'reject' : 'approve';
    const confidence = Math.max(60, 100 - (findings.length * 5));

    return {
      agentPeerId: peer.peerId,
      agentRole: role,
      verdict,
      confidence,
      weight: ROLE_WEIGHTS[role] ?? 1,
      reasoning: blocking.length > 0
        ? `Found ${blocking.length} blocking issue(s): ${blocking.map(f => f.title).join(', ')}`
        : `No blocking issues found. ${findings.length} informational finding(s).`,
      keyFindings: blocking,
      reputationScore: peer.reputationScore,
    };
  }
}

const ROLE_WEIGHTS: Record<string, number> = {
  redteam: 4, security: 3, performance: 2, style: 1, gateway: 1, coder: 1,
};
