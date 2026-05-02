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
    logger.info('Security agent ready', { peerId: (this.peerId || '').slice(0, 12) });
  }

  private heuristicScan(diff: string, files: string[]): { findings: ReviewFinding[]; summary: string; overallRisk: string } {
    const findings: ReviewFinding[] = [];
    const lines = diff.split('\n');

    const rules: Array<{
      pattern: RegExp;
      severity: ReviewFinding['severity'];
      title: string;
      description: string;
      recommendation: string;
      cweId: string;
      cvssScore: number;
    }> = [
      {
        pattern: /password\s*=\s*['"][^'"]{3,}['"]/i,
        severity: 'critical', title: 'Hardcoded Password',
        description: 'A plaintext password is hardcoded in the source. Credentials committed to version control are trivially extractable.',
        recommendation: 'Move credentials to environment variables or a secrets manager.',
        cweId: 'CWE-259', cvssScore: 9.1,
      },
      {
        pattern: /(api[_-]?key|secret[_-]?key|access[_-]?token)\s*=\s*['"][a-zA-Z0-9+/=_-]{8,}['"]/i,
        severity: 'critical', title: 'Hardcoded API Key / Secret',
        description: 'An API key or secret token is hardcoded in source code.',
        recommendation: 'Store secrets in environment variables, AWS Secrets Manager, or Vault.',
        cweId: 'CWE-798', cvssScore: 8.8,
      },
      {
        pattern: /eval\s*\(/,
        severity: 'high', title: 'Use of eval()',
        description: 'eval() executes arbitrary code and can be exploited for remote code execution if user input reaches it.',
        recommendation: 'Remove eval(). Use JSON.parse() for data, or a safe alternative.',
        cweId: 'CWE-95', cvssScore: 8.1,
      },
      {
        pattern: /exec\s*\(\s*['"`][^'"`]*\$\{/,
        severity: 'high', title: 'Command Injection via Template Literal',
        description: 'Shell command is constructed with template literals containing dynamic values.',
        recommendation: 'Use execFile() with an argument array, never interpolate user input into shell strings.',
        cweId: 'CWE-78', cvssScore: 8.6,
      },
      {
        pattern: /innerHTML\s*=\s*[^'"]/,
        severity: 'high', title: 'XSS via innerHTML Assignment',
        description: 'Setting innerHTML with dynamic content enables stored or reflected XSS.',
        recommendation: 'Use textContent for plain text, or sanitize with DOMPurify before innerHTML.',
        cweId: 'CWE-79', cvssScore: 7.4,
      },
      {
        pattern: /sql.*\+\s*\w|query.*\+\s*\w/i,
        severity: 'high', title: 'Potential SQL Injection via String Concatenation',
        description: 'SQL query built by string concatenation with dynamic values is vulnerable to injection.',
        recommendation: 'Use parameterized queries or a prepared statement API.',
        cweId: 'CWE-89', cvssScore: 9.8,
      },
      {
        pattern: /crypto\.createHash\(['"]md5['"]\)|crypto\.createHash\(['"]sha1['"]\)/i,
        severity: 'medium', title: 'Weak Cryptographic Hash (MD5/SHA-1)',
        description: 'MD5 and SHA-1 are broken for security purposes and should not be used for passwords or integrity checks.',
        recommendation: 'Use SHA-256 or stronger. For passwords, use bcrypt, scrypt, or argon2.',
        cweId: 'CWE-327', cvssScore: 5.9,
      },
      {
        pattern: /http:\/\//,
        severity: 'medium', title: 'Insecure HTTP Endpoint',
        description: 'Plaintext HTTP is used, exposing data in transit to interception.',
        recommendation: 'Use HTTPS for all external communications.',
        cweId: 'CWE-319', cvssScore: 5.3,
      },
      {
        pattern: /console\.log\(.*(?:password|token|secret|key)/i,
        severity: 'medium', title: 'Sensitive Data Logged to Console',
        description: 'Credentials or secrets are being logged, creating an exposure risk in log aggregation systems.',
        recommendation: 'Remove or redact sensitive fields before logging.',
        cweId: 'CWE-532', cvssScore: 5.5,
      },
      {
        pattern: /TODO|FIXME|HACK|XXX/,
        severity: 'low', title: 'Unresolved TODO / Security Debt',
        description: 'Code contains unresolved TODO/FIXME markers that may indicate incomplete security controls.',
        recommendation: 'Resolve or track these markers before shipping to production.',
        cweId: 'CWE-1164', cvssScore: 2.0,
      },
    ];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.startsWith('+')) continue; // Only scan added lines
      const lineNum = i + 1;
      const file = files.find(f => diff.slice(0, diff.indexOf(line)).includes(f)) ?? files[0] ?? 'unknown';

      for (const rule of rules) {
        if (rule.pattern.test(line)) {
          // Avoid duplicate findings for the same rule
          if (findings.some(f => f.title === rule.title)) continue;
          findings.push({
            id: uuidv4(),
            category: 'security',
            severity: rule.severity,
            title: rule.title,
            description: rule.description,
            location: { file, startLine: lineNum, endLine: lineNum, snippet: line.slice(0, 120) },
            recommendation: rule.recommendation,
            confidence: 72,
            cweId: rule.cweId,
            cvssScore: rule.cvssScore,
          });
        }
      }
    }

    const critical = findings.filter(f => f.severity === 'critical').length;
    const high = findings.filter(f => f.severity === 'high').length;
    const overallRisk = critical > 0 ? 'critical' : high > 0 ? 'high' : findings.length > 0 ? 'medium' : 'low';

    return {
      findings,
      summary: `Heuristic security scan (0G Compute unavailable): ${findings.length} finding(s) — ${critical} critical, ${high} high.`,
      overallRisk,
    };
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

    let teeProof: string | undefined;
    let isValid = false;
    let parsed: { findings: ReviewFinding[]; summary: string; overallRisk: string };

    try {
      const result = await this.callLLM(userMessage);
      teeProof = result.teeProof;
      isValid = result.isValid;
      const jsonMatch = result.response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON in LLM response');
      parsed = JSON.parse(jsonMatch[0]) as typeof parsed;
      if (!Array.isArray(parsed.findings)) parsed.findings = [];
    } catch (err) {
      logger.warn('0G Compute inference unavailable — running heuristic security scan', { err: String(err).slice(0, 120) });
      parsed = this.heuristicScan(diff, files ?? []);
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
