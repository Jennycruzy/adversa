import { BaseAgent } from './base-agent.js';
import { MCPServiceDef } from '../types/agent.js';
import { ReviewFinding, PRContext } from '../types/review.js';
import { logger } from '../utils/logger.js';
import { emitMeshEvent } from '../dashboard/server.js';
import { v4 as uuidv4 } from 'uuid';

export class StyleAgent extends BaseAgent {
  constructor() {
    super('style');
  }

  getSystemPrompt(): string {
    return `You are ADVERSA-STYLE — a senior software engineer focused on code quality, maintainability, and documentation standards.

Your expertise:
- Code clarity: naming conventions, variable/function names that reveal intent, magic numbers, boolean flags
- Function design: single responsibility, length (>50 lines warrants scrutiny), parameter count, side effects
- Error handling: missing try/catch, swallowed errors, generic Error vs typed errors, missing error context
- TypeScript: use of 'any', missing types, overly complex generics, improper use of type assertions
- Documentation: missing JSDoc for public APIs, outdated comments, misleading variable names
- Dead code: unused variables, unreachable code paths, deprecated APIs still in use
- Test coverage: missing tests for new code paths, test quality (testing implementation vs behavior)
- Patterns: duplicated code that should be extracted, inconsistent patterns vs rest of codebase
- Dependencies: unnecessary new dependencies, outdated package versions, license compatibility

Return JSON ONLY:
{
  "findings": [
    {
      "id": "uuid",
      "category": "style",
      "severity": "medium|low|info",
      "title": "Brief title",
      "description": "Explanation",
      "location": { "file": "path.ts", "startLine": 1, "endLine": 5 },
      "recommendation": "How to improve",
      "confidence": 90
    }
  ],
  "summary": "Overall code quality assessment",
  "overallRisk": "medium|low|none"
}`;
  }

  protected async onStart(): Promise<void> {
    logger.info('Style agent ready', { peerId: this.peerId.slice(0, 12) });
  }

  getMCPServices(): MCPServiceDef[] {
    return [{
      name: 'style-check',
      description: 'Review code style, quality, and documentation standards',
      inputSchema: {
        type: 'object',
        properties: {
          diff: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          context: { type: 'object' },
        },
        required: ['diff'],
      },
      outputSchema: {
        type: 'object',
        properties: { findings: { type: 'array' }, summary: { type: 'string' }, overallRisk: { type: 'string' } },
      },
    }];
  }

  async handleMCPCall(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'style-check') return this.performStyleCheck(params);
    throw new Error(`StyleAgent: unknown method ${method}`);
  }

  private async performStyleCheck(params: Record<string, unknown>): Promise<{
    findings: ReviewFinding[];
    summary: string;
    overallRisk: string;
  }> {
    const diff = params['diff'] as string;
    const context = params['context'] as Partial<PRContext> | undefined;

    emitMeshEvent('mcp-call', { agentRole: 'style', service: 'style-check', status: 'checking', prId: context?.id });

    const { response, teeProof, isValid } = await this.callLLM(
      `Review this code diff for style and quality:\n\nPR: ${context?.title ?? 'Unknown'}\n\n\`\`\`diff\n${diff.slice(0, 12000)}\n\`\`\`\n\nReturn ONLY valid JSON.`
    );

    let parsed: { findings: ReviewFinding[]; summary: string; overallRisk: string };
    try {
      const m = response.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : { findings: [], summary: response.slice(0, 200), overallRisk: 'none' };
      if (!Array.isArray(parsed.findings)) parsed.findings = [];
    } catch {
      parsed = { findings: [], summary: response.slice(0, 200), overallRisk: 'none' };
    }

    parsed.findings = parsed.findings.map(f => ({
      ...f,
      id: f.id ?? uuidv4(),
      category: 'style' as const,
      teeProof: isValid ? teeProof : undefined,
    }));

    logger.info('Style check complete', { findings: parsed.findings.length });
    emitMeshEvent('review-finding', { agentRole: 'style', status: 'complete', findingCount: parsed.findings.length, prId: context?.id });

    return parsed;
  }

  async handleA2ACall(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return { type: 'info', message: 'StyleAgent accepts no A2A challenges' };
  }
}
