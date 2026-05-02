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

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: AXLError) => void;
  timer: NodeJS.Timeout;
}

export class AXLClient {
  private readonly baseUrl: string;
  public selfPeerId: string = '';
  private pollInterval: NodeJS.Timeout | null = null;

  /**
   * Pending request-response correlations for callMCP() and callA2A().
   *
   * When we send an mcp_call or a2a_call message, we register a PendingCall
   * keyed by request_id. The startPolling() loop intercepts response messages
   * before passing them to the handler and resolves the matching promise.
   */
  private pendingCalls = new Map<string, PendingCall>();

  constructor(port: number = 9002, host: string = 'localhost') {
    this.baseUrl = `http://${host}:${port}`;
  }

  async initialize(): Promise<string> {
    // Use more retries on startup to tolerate Docker DNS propagation delay.
    const topo = await this.getTopology(10, 1000);
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

  async getTopology(retries = 3, delayMs = 500): Promise<{
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
    const res = await this.fetchWithRetry(`${this.baseUrl}/topology`, { method: 'GET' }, retries, delayMs);
    const body = await res.json() as {
      self_peer_id?: string;
      selfPeerId?: string;
      our_public_key?: string;
      ourPublicKey?: string;
      peers?: Array<{
        peer_id?: string;
        peerId?: string;
        address: string;
        online: boolean;
        services?: string[];
        agent_role?: string;
        agentRole?: string;
        latency_ms?: number;
        latencyMs?: number;
      }>;
      tree?: Array<{
        public_key?: string;
        publicKey?: string;
      }>;
    };

    const selfPeerId =
      body.self_peer_id ??
      body.selfPeerId ??
      body.our_public_key ??
      body.ourPublicKey ??
      body.tree?.[0]?.public_key ??
      body.tree?.[0]?.publicKey ??
      '';

    return {
      selfPeerId,
      peers: (body.peers ?? []).map(p => ({
        peerId: p.peer_id ?? p.peerId ?? '',
        address: p.address,
        online: p.online,
        services: p.services ?? [],
        agentRole: p.agent_role ?? p.agentRole,
        latencyMs: p.latency_ms ?? p.latencyMs,
      })),
    };
  }

  // ─── MCP service calls ────────────────────────────────────────────────────────
  //
  // Protocol: send {type:'mcp_call', service, method, params, request_id} via
  // the message queue (/send → target /deliver → target /recv poll).
  // The target agent calls handleMCPCall(), then sends back
  // {type:'mcp_response', result, request_id} via /send.
  // startPolling() intercepts that response and resolves the pending promise.
  //
  // If the broker exposes native /mcp/:peerId/:service HTTP forwarding that
  // returns a real result (not a stub), that path is tried first.

  async callMCP(
    peerId: string,
    service: string,
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 45000
  ): Promise<unknown> {
    const requestId = crypto.randomUUID();

    // Register the pending promise BEFORE sending to avoid races.
    const responsePromise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCalls.delete(requestId);
        reject(new AXLError(
          'MCP_TIMEOUT',
          `MCP call timed out after ${timeoutMs}ms: ${service}.${method} → ${peerId.slice(0, 12)}`
        ));
      }, timeoutMs);
      this.pendingCalls.set(requestId, { resolve, reject, timer });
    });

    // Send via message queue — works regardless of broker version.
    await this.send(peerId, {
      type: 'mcp_call',
      service,
      method,
      params,
      request_id: requestId,
    });

    logger.debug('AXL MCP call sent', { peerId: peerId.slice(0, 12), service, method, requestId: requestId.slice(0, 8) });
    return responsePromise;
  }

  // ─── A2A agent calls ──────────────────────────────────────────────────────────
  //
  // Same protocol as MCP: send {type:'a2a_call', payload, from_peer, request_id},
  // wait for {type:'a2a_response', ...result, request_id} via polling.

  async callA2A(
    peerId: string,
    payload: Record<string, unknown>,
    timeoutMs = 45000
  ): Promise<Record<string, unknown>> {
    const requestId = crypto.randomUUID();

    const responsePromise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCalls.delete(requestId);
        reject(new AXLError(
          'A2A_TIMEOUT',
          `A2A call timed out after ${timeoutMs}ms → ${peerId.slice(0, 12)}`
        ));
      }, timeoutMs);
      this.pendingCalls.set(requestId, { resolve, reject, timer });
    });

    await this.send(peerId, {
      type: 'a2a_call',
      payload,
      from_peer: this.selfPeerId,
      request_id: requestId,
      timestamp: Date.now(),
    });

    logger.debug('AXL A2A call sent', { peerId: peerId.slice(0, 12), type: payload['type'], requestId: requestId.slice(0, 8) });
    return responsePromise as Promise<Record<string, unknown>>;
  }

  // ─── GossipSub ────────────────────────────────────────────────────────────────
  //
  // The real AXL binary exposes core endpoints: /send /recv /topology /mcp/ /a2a/
  // GossipSub is implemented here as an application-level protocol on top of
  // raw /send and /recv, with a try-first on native /gossip/* endpoints in case
  // the binary version running locally exposes them.

  /** Whether the native /gossip/* endpoints are available on this AXL node. Cached after first probe. */
  private nativeGossipAvailable: boolean | null = null;

  async gossipPublish(topic: string, data: Record<string, unknown>): Promise<void> {
    // Try native gossip endpoint first (probe once and cache the result)
    if (this.nativeGossipAvailable !== false) {
      try {
        const encoded = Buffer.from(JSON.stringify(data)).toString('base64');
        await this.fetchWithRetry(`${this.baseUrl}/gossip/publish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ topic, data: encoded }),
        }, 0);  // no retries for probe
        this.nativeGossipAvailable = true;
        logger.debug('AXL gossip publish (native)', { topic });
        return;
      } catch {
        this.nativeGossipAvailable = false;
        logger.debug('AXL native gossip not available — using application-level broadcast', { topic });
      }
    }

    // Application-level gossip: broadcast to all online peers via /send
    // Envelope format: { _gossip: true, _topic: topic, ...data }
    try {
      const topo = await this.getTopology();
      const onlinePeers = topo.peers.filter(p => p.online && p.peerId !== this.selfPeerId);
      const payload: Record<string, unknown> = { _gossip: true, _topic: topic, ...data };
      await Promise.allSettled(
        onlinePeers.map(p => this.send(p.peerId, payload).catch(() => {/* ignore per-peer send errors */}))
      );
      logger.debug('AXL gossip publish (app-level broadcast)', { topic, peerCount: onlinePeers.length });
    } catch (err) {
      logger.warn('AXL gossip publish failed', { topic, err });
    }
  }

  async gossipReceive(topic: string): Promise<Array<{
    from: string;
    data: Record<string, unknown>;
    timestamp: number;
  }>> {
    // Try native gossip endpoint first
    if (this.nativeGossipAvailable !== false) {
      try {
        const res = await this.fetchWithRetry(
          `${this.baseUrl}/gossip/messages/${encodeURIComponent(topic)}`,
          { method: 'GET' },
          0,  // no retries for probe
        );
        const body = await res.json() as {
          messages?: Array<{ from: string; data: string; timestamp: number }>;
        };
        this.nativeGossipAvailable = true;
        return (body.messages ?? []).map(m => ({
          from: m.from,
          data: JSON.parse(Buffer.from(m.data, 'base64').toString('utf8')) as Record<string, unknown>,
          timestamp: m.timestamp,
        }));
      } catch {
        this.nativeGossipAvailable = false;
      }
    }

    // Application-level: pull from /recv and filter by topic envelope.
    // NOTE: this drains ALL pending messages. Only used when broker has no
    // native gossip support. In that case no MCP/A2A calls should be in flight
    // simultaneously on the same recv queue without proper correlation routing.
    const messages = await this.recv();
    return messages
      .filter(m => m.data['_gossip'] === true && m.data['_topic'] === topic)
      .map(m => {
        const { _gossip: _g, _topic: _t, ...rest } = m.data;
        return { from: m.from, data: rest, timestamp: m.timestamp };
      });
  }

  // ─── Convergecast ─────────────────────────────────────────────────────────────
  //
  // Application-level convergecast: each participant sends its data to the
  // gateway via /send, the gateway collects and aggregates.
  // Native /convergecast endpoint is tried first.

  async convergecast(
    topic: string,
    data: Record<string, unknown>,
    aggregationFn: 'sum' | 'max' | 'min' | 'collect' = 'collect'
  ): Promise<{ aggregated: unknown; contributorCount: number }> {
    // Try native convergecast endpoint first
    try {
      const encoded = Buffer.from(JSON.stringify(data)).toString('base64');
      const res = await this.fetchWithRetry(`${this.baseUrl}/convergecast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, data: encoded, aggregation_fn: aggregationFn }),
      }, 0);
      const result = await res.json() as { aggregated: string; contributor_count: number };
      return {
        aggregated: JSON.parse(Buffer.from(result.aggregated, 'base64').toString('utf8')),
        contributorCount: result.contributor_count,
      };
    } catch {
      // Fall through to application-level aggregation
    }

    // Application-level convergecast: collect any contributions that have
    // already arrived via /recv (agents send their data directly), then
    // include our own data as well. In the ADVERSA pipeline, votes are
    // primarily collected as MCP response bodies; this handles any additional
    // direct-send contributions.
    const messages = await this.recv();
    const contributions = messages
      .filter(m => m.data['_convergecast'] === true && m.data['_topic'] === topic)
      .map(m => {
        const { _convergecast: _c, _topic: _t, _aggregation: _a, ...rest } = m.data;
        return rest;
      });

    contributions.push({ ...data }); // include caller's own data point

    let aggregated: unknown;
    if (aggregationFn === 'collect') {
      aggregated = contributions;
    } else if (aggregationFn === 'sum') {
      aggregated = contributions.reduce((acc, c) => {
        const val = typeof c['value'] === 'number' ? c['value'] : 0;
        return (acc as number) + val;
      }, 0);
    } else if (aggregationFn === 'max') {
      aggregated = contributions.reduce((acc, c) => {
        const val = typeof c['value'] === 'number' ? c['value'] : -Infinity;
        return Math.max(acc as number, val);
      }, -Infinity);
    } else {
      aggregated = contributions;
    }

    return { aggregated, contributorCount: contributions.length };
  }

  // ─── Polling ─────────────────────────────────────────────────────────────────
  //
  // The polling loop is the single consumer of /recv. Before dispatching to the
  // caller's handler it intercepts mcp_response, a2a_response, mcp_error, and
  // a2a_error messages and routes them to the matching pending promise registered
  // by callMCP() / callA2A(). All other messages are passed through to handler.

  startPolling(
    intervalMs: number,
    handler: (msg: DecodedMessage) => void
  ): void {
    this.pollInterval = setInterval(async () => {
      try {
        const messages = await this.recv();
        for (const msg of messages) {
          const type = msg.data['type'] as string | undefined;
          const requestId = msg.data['request_id'] as string | undefined;

          // Route response messages back to pending callMCP / callA2A promises.
          if (requestId && (type === 'mcp_response' || type === 'a2a_response')) {
            const pending = this.pendingCalls.get(requestId);
            if (pending) {
              clearTimeout(pending.timer);
              this.pendingCalls.delete(requestId);
              if (type === 'mcp_response') {
                pending.resolve(msg.data['result']);
              } else {
                // a2a_response: return the full data object (caller accesses fields directly)
                pending.resolve(msg.data);
              }
              continue; // do not pass to application handler
            }
          }

          // Route error messages to pending promises.
          if (requestId && (type === 'mcp_error' || type === 'a2a_error')) {
            const pending = this.pendingCalls.get(requestId);
            if (pending) {
              clearTimeout(pending.timer);
              this.pendingCalls.delete(requestId);
              pending.reject(new AXLError(
                'REMOTE_ERROR',
                `Remote ${type}: ${String(msg.data['error'] ?? 'unknown error')}`
              ));
              continue;
            }
          }

          // Pass all other messages to the application handler.
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
    // Reject any still-pending calls to avoid memory leaks on shutdown.
    for (const [id, pending] of this.pendingCalls) {
      clearTimeout(pending.timer);
      pending.reject(new AXLError('SHUTDOWN', 'AXL client shut down with pending calls'));
      this.pendingCalls.delete(id);
    }
  }
}
