import { logger } from '../utils/logger.js';

export class AXLError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'AXLError';
  }
}

interface DecodedMessage {
  from: string;
  data: Record<string, unknown>;
  timestamp: number;
  messageId: string;
}

export class AXLClient {
  private readonly baseUrl: string;
  public selfPeerId: string = '';
  private pollInterval: NodeJS.Timeout | null = null;

  constructor(port: number = 9002) {
    this.baseUrl = `http://localhost:${port}`;
  }

  async initialize(): Promise<string> {
    const topo = await this.getTopology();
    this.selfPeerId = topo.selfPeerId;
    logger.info('AXL client initialized', { peerId: this.selfPeerId, baseUrl: this.baseUrl });
    return this.selfPeerId;
  }

  private async fetchWithRetry(
    url: string,
    options: RequestInit,
    retries = 3,
    delayMs = 500
  ): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const res = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(timeout);
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new AXLError(
            'HTTP_ERROR',
            `AXL ${options.method} ${url} → ${res.status} ${res.statusText}: ${body}`
          );
        }
        return res;
      } catch (err) {
        lastError = err;
        if (attempt < retries) {
          const backoff = delayMs * Math.pow(2, attempt);
          logger.warn('AXL request retrying', { attempt: attempt + 1, url, backoffMs: backoff });
          await new Promise(r => setTimeout(r, backoff));
        }
      }
    }
    throw lastError instanceof AXLError
      ? lastError
      : new AXLError('MAX_RETRIES', `Max retries exceeded for ${url}`, lastError);
  }

  // ─── Raw messaging ───────────────────────────────────────────────────────────

  async send(peerId: string, data: Record<string, unknown>): Promise<void> {
    const encoded = Buffer.from(JSON.stringify(data)).toString('base64');
    await this.fetchWithRetry(`${this.baseUrl}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ peer_id: peerId, data: encoded }),
    });
    logger.debug('AXL send', { to: peerId.slice(0, 12), type: data['type'] });
  }

  async recv(): Promise<DecodedMessage[]> {
    const res = await this.fetchWithRetry(`${this.baseUrl}/recv`, { method: 'GET' });
    const body = await res.json() as {
      messages?: Array<{ from: string; data: string; timestamp: number; message_id: string }>;
    };
    return (body.messages ?? []).map(m => ({
      from: m.from,
      data: JSON.parse(Buffer.from(m.data, 'base64').toString('utf8')) as Record<string, unknown>,
      timestamp: m.timestamp,
      messageId: m.message_id,
    }));
  }

  // ─── Topology discovery ───────────────────────────────────────────────────────

  async getTopology(): Promise<{
    selfPeerId: string;
    peers: Array<{
      peerId: string;
      address: string;
      online: boolean;
      services: string[];
      agentRole?: string;
      latencyMs?: number;
    }>;
  }> {
    const res = await this.fetchWithRetry(`${this.baseUrl}/topology`, { method: 'GET' });
    const body = await res.json() as {
      self_peer_id: string;
      peers: Array<{
        peer_id: string;
        address: string;
        online: boolean;
        services?: string[];
        agent_role?: string;
        latency_ms?: number;
      }>;
    };
    return {
      selfPeerId: body.self_peer_id,
      peers: (body.peers ?? []).map(p => ({
        peerId: p.peer_id,
        address: p.address,
        online: p.online,
        services: p.services ?? [],
        agentRole: p.agent_role,
        latencyMs: p.latency_ms,
      })),
    };
  }

  // ─── MCP service calls ────────────────────────────────────────────────────────

  async callMCP(
    peerId: string,
    service: string,
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const requestId = crypto.randomUUID();
    const body: Record<string, unknown> = { jsonrpc: '2.0', method, params, id: requestId };
    const res = await this.fetchWithRetry(
      `${this.baseUrl}/mcp/${encodeURIComponent(peerId)}/${encodeURIComponent(service)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    const response = await res.json() as {
      jsonrpc: string;
      result?: unknown;
      error?: { code: number; message: string };
      id: string;
    };
    if (response.error) {
      throw new AXLError(
        'MCP_REMOTE_ERROR',
        `Remote MCP error on ${service}.${method}: ${response.error.message}`,
        response.error
      );
    }
    logger.debug('AXL MCP call', { peerId: peerId.slice(0, 12), service, method });
    return response.result;
  }

  // ─── A2A agent calls ──────────────────────────────────────────────────────────

  async callA2A(
    peerId: string,
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const requestId = crypto.randomUUID();
    const body: Record<string, unknown> = {
      ...payload,
      from_peer: this.selfPeerId,
      request_id: requestId,
      timestamp: Date.now(),
    };
    const res = await this.fetchWithRetry(
      `${this.baseUrl}/a2a/${encodeURIComponent(peerId)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    const response = await res.json() as Record<string, unknown>;
    logger.debug('AXL A2A call', { peerId: peerId.slice(0, 12), type: payload['type'] });
    return response;
  }

  // ─── GossipSub ────────────────────────────────────────────────────────────────

  async gossipPublish(topic: string, data: Record<string, unknown>): Promise<void> {
    const encoded = Buffer.from(JSON.stringify(data)).toString('base64');
    await this.fetchWithRetry(`${this.baseUrl}/gossip/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, data: encoded }),
    });
    logger.debug('AXL gossip publish', { topic });
  }

  async gossipReceive(topic: string): Promise<Array<{
    from: string;
    data: Record<string, unknown>;
    timestamp: number;
  }>> {
    const res = await this.fetchWithRetry(
      `${this.baseUrl}/gossip/messages/${encodeURIComponent(topic)}`,
      { method: 'GET' }
    );
    const body = await res.json() as {
      messages?: Array<{ from: string; data: string; timestamp: number }>;
    };
    return (body.messages ?? []).map(m => ({
      from: m.from,
      data: JSON.parse(Buffer.from(m.data, 'base64').toString('utf8')) as Record<string, unknown>,
      timestamp: m.timestamp,
    }));
  }

  // ─── Convergecast ─────────────────────────────────────────────────────────────

  async convergecast(
    topic: string,
    data: Record<string, unknown>,
    aggregationFn: 'sum' | 'max' | 'min' | 'collect' = 'collect'
  ): Promise<{ aggregated: unknown; contributorCount: number }> {
    const encoded = Buffer.from(JSON.stringify(data)).toString('base64');
    const res = await this.fetchWithRetry(`${this.baseUrl}/convergecast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, data: encoded, aggregation_fn: aggregationFn }),
    });
    const result = await res.json() as { aggregated: string; contributor_count: number };
    return {
      aggregated: JSON.parse(Buffer.from(result.aggregated, 'base64').toString('utf8')),
      contributorCount: result.contributor_count,
    };
  }

  // ─── Polling ─────────────────────────────────────────────────────────────────

  startPolling(
    intervalMs: number,
    handler: (msg: DecodedMessage) => void
  ): void {
    this.pollInterval = setInterval(async () => {
      try {
        const messages = await this.recv();
        for (const msg of messages) {
          handler(msg);
        }
      } catch (err) {
        logger.debug('AXL recv poll error', { err });
      }
    }, intervalMs);
  }

  stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }
}
