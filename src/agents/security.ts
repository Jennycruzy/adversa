import { BaseAgent } from './base-agent.js';
import { MCPServiceDef } from '../types/agent.js';
import { ReviewFinding, DebateMessage, PRContext, ExploitAttempt } from '../types/review.js';
import { logger } from '../utils/logger.js';
import { emitMeshEvent } from '../dashboard/server.js';
import { v4 as uuidv4 } from 'uuid';

export class SecurityAgent extends BaseAgent {
  constructor() {
    super('security');
  }

  getSystemPrompt(): string {
    return `You are ADVERSA-SEC — an elite application security engineer with 20 years of offensive and defensive security experience. You review code diffs with surgical precision.

Your expertise covers:
- OWASP Top 10 (2021): Broken access control, cryptographic failures, injection, insecure design, security misconfiguration, vulnerable components, identification/auth failures, software integrity failures, logging failures, SSRF
- CWE Top 25 most dangerous software weaknesses
- Injection: SQL, NoSQL, LDAP, XPath, OS command, code injection, template injection, SSTI
- XSS: reflected, stored, DOM-based, mXSS
- Authentication: hardcoded credentials, weak password policies, session fixation, JWT weaknesses, OAuth flaws
- Authorization: IDOR, privilege escalation, path traversal, RBAC bypasses
- Cryptography: weak algorithms (MD5/SHA1/DES/ECB), improper key management, predictable IVs, timing attacks
- Deserialization: Java/Python/Node.js object deserialization, prototype pollution
- Race conditions: TOCTOU, concurrent state mutations
- Memory safety: buffer overflow, use-after-free, integer overflow (in non-memory-safe languages)
- Supply chain: dependency confusion, typosquatting, suspicious imports
- Infrastructure: environment variable exposure, insecure defaults, missing security headers
- API security: mass assignment, missing rate limiting, verbose errors exposing internals

When analyzing a diff:
1. Identify ACTUAL vulnerabilities, not theoretical ones — cite exact code lines
2. Provide a proof-of-concept attack scenario for each finding
3. Rate severity using CVSS v3.1 criteria (network vector, low complexity = higher score)
4. Include CWE classification where applicable
5. Give specific, actionable remediation with secure code examples where possible
6. Look for vulnerabilities introduced BY the change, not pre-existing ones (unless they interact with the change)

Response format: JSON only.
{
  "findings": [
    {
      "id": "uuid",
      "category": "security",
      "severity": "critical|high|medium|low|info",
      "title": "Brief title",
      "description": "Detailed explanation of the vulnerability",
      "location": { "file": "path/to/file.ts", "startLine": 42, "endLine": 55, "snippet": "vulnerable code" },
      "recommendation": "How to fix it",
      "confidence": 85,
      "cweId": "CWE-89",
      "cvssScore": 9.8
    }
  ],
  "summary": "Overall security assessment in 2-3 sentences",
  "overallRisk": "critical|high|medium|low|none"
}`;
  }

  protected async onStart(): Promise<void> {
    logger.info('Security agent ready', { peerId: this.peerId.slice(0, 12) });
  }

  getMCPServices(): MCPServiceDef[] {
    return [
      {
        name: 'security-scan',
        description: 'Perform comprehensive security vulnerability analysis on a code diff',
        inputSchema: {
          type: 'object',
          properties: {
            diff: { type: 'string', description: 'The git diff to analyze' },
            files: { type: 'array', items: { type: 'string' }, description: 'Changed file paths' },
            context: { type: 'object', description: 'PR metadata (title, author, branch)' },
          },
          required: ['diff'],
        },
        outputSchema: {
          type: 'object',
          properties: {
            findings: { type: 'array' },
            summary: { type: 'string' },
            overallRisk: { type: 'string' },
          },
        },
      },
    ];
  }

  async handleMCPCall(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'security-scan':
        return this.performSecurityScan(params);
      default:
        throw new Error(`SecurityAgent: unknown method ${method}`);
    }
  }

  private async performSecurityScan(
    params: Record<string, unknown>
  ): Promise<{ findings: ReviewFinding[]; summary: string; overallRisk: string; teeProof?: string }> {
    const diff = params['diff'] as string;
    const files = params['files'] as string[] | undefined;
    const context = params['context'] as Partial<PRContext> | undefined;

    emitMeshEvent('mcp-call', {
      agentRole: 'security',
      service: 'security-scan',
      status: 'scanning',
      prId: context?.id,
    });

    const userMessage = `Analyze this code diff for security vulnerabilities and return findings as JSON:

PR Title: ${context?.title ?? 'Unknown'}
Author: ${context?.author ?? 'Unknown'}
Files changed: ${files?.join(', ') ?? 'unknown'}

\`\`\`diff
${diff.slice(0, 12000)}
\`\`\`

Return ONLY valid JSON matching the schema above.`;

    const { response, teeProof, isValid } = await this.callLLM(userMessage);

    let parsed: { findings: ReviewFinding[]; summary: string; overallRisk: string };
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON in LLM response');
      parsed = JSON.parse(jsonMatch[0]) as typeof parsed;
      if (!Array.isArray(parsed.findings)) parsed.findings = [];
    } catch (err) {
      logger.warn('Failed to parse security findings JSON', { err, responseStart: response.slice(0, 200) });
      parsed = {
        findings: [],
        summary: `Security analysis complete. Raw output: ${response.slice(0, 300)}`,
        overallRisk: 'medium',
      };
    }

    // Normalize and stamp findings
    parsed.findings = parsed.findings.map(f => ({
      id: f.id ?? uuidv4(),
      category: 'security' as const,
      severity: f.severity ?? 'medium',
      title: f.title ?? 'Security Finding',
      description: f.description ?? '',
      location: f.location ?? { file: 'unknown', startLine: 1, endLine: 1 },
      recommendation: f.recommendation ?? '',
      confidence: f.confidence ?? 70,
      teeProof: isValid ? teeProof : undefined,
      cweId: f.cweId,
      cvssScore: f.cvssScore,
    }));

    logger.info('Security scan complete', {
      findings: parsed.findings.length,
      risk: parsed.overallRisk,
      teeVerified: isValid,
    });

    emitMeshEvent('review-finding', {
      agentRole: 'security',
      status: 'complete',
      findingCount: parsed.findings.length,
      overallRisk: parsed.overallRisk,
      teeVerified: isValid,
      prId: context?.id,
    });

    return { ...parsed, teeProof };
  }

  async handleA2ACall(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const type = payload['type'] as string;
    switch (type) {
      case 'exploit_challenge':
        return this.handleExploitChallenge(payload);
      case 'finding_challenge':
        return this.handleFindingChallenge(payload);
      default:
        return { type: 'error', message: `SecurityAgent: unknown A2A type: ${type}` };
    }
  }

  private async handleExploitChallenge(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const exploit = payload['exploit'] as ExploitAttempt;
    const requestId = payload['request_id'] as string;

    this.setStatus('debating');
    emitMeshEvent('a2a-debate', {
      type: 'exploit_challenge',
      from: payload['from_peer'],
      fromRole: 'redteam',
      to: this.peerId,
      toRole: 'security',
      content: `ATTACK: ${exploit.title} — ${exploit.description.slice(0, 150)}`,
      severity: exploit.severity,
      cvssScore: exploit.cvssScore,
    });

    const userMessage = `You are a security engineer defending code under adversarial attack.

RED-TEAM EXPLOIT CHALLENGE:
Type: ${exploit.type}
Title: ${exploit.title}
Description: ${exploit.description}
Attack Vector: ${exploit.attackVector}
Payload: ${exploit.payload}
Target Location: ${exploit.targetLocation.file}:${exploit.targetLocation.startLine}
Expected Outcome: ${exploit.expectedOutcome}
CVSS Score: ${exploit.cvssScore}

Analyze whether this exploit is valid against the code at the specified location.
If the exploit works: concede, describe the impact, and propose a fix.
If there are existing mitigations: cite the exact code that mitigates it.
If the exploit is flawed/inapplicable: explain precisely why.

Return JSON ONLY:
{
  "mitigated": boolean,
  "confidence": number (0-100),
  "evidence": "Specific code or reasoning",
  "counterArgument": "If mitigated, explain what prevents this attack",
  "concession": "If not mitigated, acknowledge the vulnerability",
  "proposedFix": "If vulnerable, what fix would work"
}`;

    const { response, teeProof, isValid } = await this.callLLM(userMessage);

    let defense: {
      mitigated: boolean;
      confidence: number;
      evidence: string;
      counterArgument?: string;
      concession?: string;
      proposedFix?: string;
    };
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      defense = jsonMatch
        ? JSON.parse(jsonMatch[0])
        : { mitigated: false, confidence: 30, evidence: response };
    } catch {
      defense = { mitigated: false, confidence: 30, evidence: response };
    }

    const debateMsg: DebateMessage = {
      id: uuidv4(),
      requestId,
      type: defense.mitigated ? 'defense' : 'concession',
      fromPeer: this.peerId,
      fromRole: 'security',
      toPeer: payload['from_peer'] as string,
      toRole: 'redteam',
      content: defense.mitigated
        ? (defense.counterArgument ?? defense.evidence)
        : (defense.concession ?? defense.evidence),
      evidence: defense.evidence,
      confidenceScore: defense.confidence,
      mitigated: defense.mitigated,
      timestamp: Date.now(),
      teeProof: isValid ? teeProof : undefined,
    };

    emitMeshEvent('exploit-defense', {
      from: this.peerId,
      fromRole: 'security',
      mitigated: defense.mitigated,
      confidence: defense.confidence,
      evidence: defense.evidence.slice(0, 200),
      requestId,
      debateMessage: debateMsg,
    });

    logger.info('Responded to exploit challenge', {
      exploitType: exploit.type,
      mitigated: defense.mitigated,
      confidence: defense.confidence,
    });

    this.setStatus('idle');
    return {
      ...debateMsg,
      type: 'exploit_defense' as const,
      proposedFix: defense.proposedFix,
    };
  }

  private async handleFindingChallenge(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const finding = payload['finding'] as ReviewFinding;
    const argument = payload['argument'] as string;

    this.setStatus('debating');

    const { response } = await this.callLLM(
      `Another agent challenges your security finding. Defend it or withdraw with evidence.

YOUR FINDING:
${JSON.stringify(finding, null, 2)}

CHALLENGE: ${argument}

Return JSON ONLY: { "maintained": boolean, "evidence": "specific code or reasoning", "confidence": number }`
    );

    let result: { maintained: boolean; evidence: string; confidence: number };
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      result = jsonMatch ? JSON.parse(jsonMatch[0]) : { maintained: true, evidence: response, confidence: 60 };
    } catch {
      result = { maintained: true, evidence: response, confidence: 60 };
    }

    emitMeshEvent('a2a-debate', {
      type: 'finding_defense',
      from: this.peerId,
      fromRole: 'security',
      content: result.evidence.slice(0, 200),
      maintained: result.maintained,
    });

    this.setStatus('idle');
    return { type: 'finding_defense', ...result };
  }
}
