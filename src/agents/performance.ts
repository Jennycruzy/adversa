import { BaseAgent } from './base-agent.js';
import { MCPServiceDef } from '../types/agent.js';
import { ReviewFinding, PRContext } from '../types/review.js';
import { logger } from '../utils/logger.js';
import { emitMeshEvent } from '../dashboard/server.js';
import { v4 as uuidv4 } from 'uuid';

export class PerformanceAgent extends BaseAgent {
  constructor() {
    super('performance');
  }

  getSystemPrompt(): string {
    return `You are ADVERSA-PERF — a performance engineering expert specializing in code efficiency, algorithmic complexity, and scalability.

Your expertise covers:
- Algorithm complexity: O(n²) loops that should be O(n), unnecessary nested iterations
- Database: N+1 queries, missing indexes, full table scans, missing pagination, missing transactions
- Memory: memory leaks (event listeners, closures, circular refs, large array accumulation), excessive allocations
- Async/concurrency: blocking event loops, missing Promise.all() when operations are independent, unnecessary await in loops
- Caching: missing caches for expensive computations, cache invalidation bugs, cache stampede patterns
- Network: missing request batching, chatty APIs (many small requests vs one larger request), missing compression
- Bundling: large dependencies imported fully when only one function needed
- React-specific: missing memo/useMemo/useCallback, inline function creation in render, missing keys
- Node.js-specific: synchronous fs operations in request handlers, blocking JSON.parse of large payloads

When reviewing:
1. Identify concrete, measurable performance issues — not "this could be slow" but "this is O(n²) because..."
2. Estimate impact: "Under 1000 users this is fine; at 10,000 concurrent users this will cause X"
3. Provide a specific optimization with a code example
4. Flag anything that could cause production incidents at scale

Return JSON ONLY:
{
  "findings": [
    {
      "id": "uuid",
      "category": "performance",
      "severity": "critical|high|medium|low|info",
      "title": "Brief title",
      "description": "Explanation with complexity analysis",
      "location": { "file": "path.ts", "startLine": 10, "endLine": 20, "snippet": "code" },
      "recommendation": "Specific fix with code example",
      "confidence": 85,
      "estimatedImpact": "Description of performance impact at scale"
    }
  ],
  "summary": "Overall performance assessment",
  "overallRisk": "critical|high|medium|low|none"
}`;
  }

  protected async onStart(): Promise<void> {
    logger.info('Performance agent ready', { peerId: this.peerId.slice(0, 12) });
  }

  getMCPServices(): MCPServiceDef[] {
    return [{
      name: 'perf-analysis',
      description: 'Analyze code diff for performance issues, complexity problems, and scalability concerns',
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
    if (method === 'perf-analysis') return this.performAnalysis(params);
    throw new Error(`PerformanceAgent: unknown method ${method}`);
  }

  private async performAnalysis(params: Record<string, unknown>): Promise<{
    findings: ReviewFinding[];
    summary: string;
    overallRisk: string;
  }> {
    const diff = params['diff'] as string;
    const context = params['context'] as Partial<PRContext> | undefined;

    emitMeshEvent('mcp-call', { agentRole: 'performance', service: 'perf-analysis', status: 'analyzing', prId: context?.id });

    const { response, teeProof, isValid } = await this.callLLM(
      `Analyze this code diff for performance issues:\n\nPR: ${context?.title ?? 'Unknown'}\n\n\`\`\`diff\n${diff.slice(0, 12000)}\n\`\`\`\n\nReturn ONLY valid JSON.`
    );

    let parsed: { findings: ReviewFinding[]; summary: string; overallRisk: string };
    try {
      const m = response.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : { findings: [], summary: response.slice(0, 200), overallRisk: 'low' };
      if (!Array.isArray(parsed.findings)) parsed.findings = [];
    } catch {
      parsed = { findings: [], summary: response.slice(0, 200), overallRisk: 'low' };
    }

    parsed.findings = parsed.findings.map(f => ({
      ...f,
      id: f.id ?? uuidv4(),
      category: 'performance' as const,
      teeProof: isValid ? teeProof : undefined,
    }));

    logger.info('Performance analysis complete', { findings: parsed.findings.length });
    emitMeshEvent('review-finding', { agentRole: 'performance', status: 'complete', findingCount: parsed.findings.length, prId: context?.id });

    return parsed;
  }

  async handleA2ACall(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const type = payload['type'] as string;
    if (type === 'finding_challenge') {
      const finding = payload['finding'] as ReviewFinding;
      const { response } = await this.callLLM(
        `Defend or withdraw this performance finding:\n${JSON.stringify(finding, null, 2)}\n\nChallenge: ${payload['argument']}\n\nReturn JSON: { "maintained": boolean, "evidence": "string", "confidence": number }`
      );
      const m = response.match(/\{[\s\S]*\}/);
      const result = m ? JSON.parse(m[0]) : { maintained: true, evidence: response, confidence: 60 };
      return { type: 'finding_defense', ...result };
    }
    return { type: 'error', message: 'PerformanceAgent: unsupported A2A type' };
  }
}
