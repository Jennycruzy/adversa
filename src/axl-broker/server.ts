/**
 * ADVERSA AXL Mesh Broker
 *
 * Lightweight HTTP message broker implementing the AXL node API.
 * One instance runs per agent (sidecar pattern). Agents call localhost:{port}
 * and this broker handles forwarding to peer brokers over the Docker network.
 *
 * API surface:
 *   GET  /topology                   — peer list
 *   GET  /recv                       — drain inbound message queue
 *   POST /send                       — send to a peer (forwarded via HTTP)
 *   POST /deliver                    — receive from another broker (internal)
 *   POST /a2a/:peerId                — agent-to-agent call (forwarded)
 *   POST /a2a-recv                   — receive A2A call (internal)
 *   POST /mcp/:peerId/:service       — MCP call (forwarded)
 *   POST /gossip/publish             — fan-out to all peers
 *   POST /gossip/receive             — receive gossip (internal)
 *   GET  /gossip/messages/:topic     — drain gossip queue for topic
 *   POST /convergecast               — collect from all peers
 *   POST /convergecast-recv          — receive convergecast (internal)
 *   POST /register                   — peer handshake
 *   GET  /health                     — liveness probe
 */

import express, { Request, Response } from 'express';
import { randomUUID } from 'crypto';

const app = express();
app.use(express.json({ limit: '4mb' }));

const ROLE = process.env.AGENT_ROLE ?? 'gateway';
const PORT = parseInt(process.env.AXL_NODE_PORT ?? '9002');
const SELF_PEER_ID = `${ROLE}-${randomUUID().slice(0, 8)}`;

interface PeerInfo {
  peerId: string;
  address: string;   // host:port
  online: boolean;
  role: string;
  lastSeen: number;
}

interface Message {
  from: string;
  data: string;      // base64-encoded JSON
  timestamp: number;
  message_id: string;
}

const peers = new Map<string, PeerInfo>();
const inboundQueue: Message[] = [];
const gossipQueues = new Map<string, Array<{ from: string; data: string; timestamp: number }>>();

// ─── Peer setup ──────────────────────────────────────────────────────────────

function parsePeers(): void {
  const raw = process.env.PEERS ?? '';
  if (!raw) return;
  for (const entry of raw.split(',')) {
    const [role, address] = entry.split('=');
    if (role && address && role.trim() !== ROLE) {
      peers.set(role.trim(), {
        peerId: `${role.trim()}-unknown`,
        address: address.trim(),
        online: false,
        role: role.trim(),
        lastSeen: 0,
      });
    }
  }
}

async function fetchPeer(address: string, path: string, body: unknown): Promise<Response> {
  const res = await fetch(`http://${address}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  return res as unknown as Response;
}

// ─── Registration ─────────────────────────────────────────────────────────────

app.post('/register', (req: Request, res: Response) => {
  const { peer_id, role, address } = req.body as { peer_id: string; role: string; address: string };
  if (role && peer_id) {
    peers.set(role, { peerId: peer_id, address, online: true, role, lastSeen: Date.now() });
    console.log(`[AXL:${ROLE}] Registered peer: ${role} (${peer_id.slice(0, 12)})`);
  }
  res.json({ success: true, peer_id: SELF_PEER_ID, role: ROLE });
});

// ─── Topology ─────────────────────────────────────────────────────────────────

app.get('/topology', (_req: Request, res: Response) => {
  res.json({
    self_peer_id: SELF_PEER_ID,
    peers: Array.from(peers.values()).map(p => ({
      peer_id: p.peerId,
      address: p.address,
      online: p.online,
      services: ['axl', 'mcp', 'a2a', 'gossip'],
      agent_role: p.role,
      latency_ms: p.online ? Date.now() - p.lastSeen : null,
    })),
  });
});

// ─── Message recv / deliver ───────────────────────────────────────────────────

app.get('/recv', (_req: Request, res: Response) => {
  const messages = inboundQueue.splice(0);
  res.json({ messages });
});

app.post('/deliver', (req: Request, res: Response) => {
  const msg = req.body as Message;
  inboundQueue.push(msg);
  res.json({ success: true });
});

// ─── Send to peer ─────────────────────────────────────────────────────────────

app.post('/send', async (req: Request, res: Response) => {
  const { peer_id, data } = req.body as { peer_id: string; data: string };

  const peer = Array.from(peers.values()).find(p => p.peerId === peer_id);
  if (!peer) {
    res.json({ success: false, error: `Unknown peer: ${peer_id}` });
    return;
  }

  const message: Message = {
    from: SELF_PEER_ID,
    data,
    timestamp: Date.now(),
    message_id: randomUUID(),
  };

  try {
    await fetchPeer(peer.address, '/deliver', message);
    peer.online = true;
    peer.lastSeen = Date.now();
    res.json({ success: true, message_id: message.message_id });
  } catch (err) {
    peer.online = false;
    res.json({ success: false, error: String(err) });
  }
});

// ─── A2A ──────────────────────────────────────────────────────────────────────

app.post('/a2a/:peerId', async (req: Request, res: Response) => {
  const { peerId } = req.params;
  const peer = Array.from(peers.values()).find(p => p.peerId === peerId);

  if (!peer) {
    // Self or unknown — echo ack
    res.json({
      type: 'a2a_response',
      from_peer: SELF_PEER_ID,
      request_id: (req.body as { request_id?: string }).request_id,
      payload: {},
    });
    return;
  }

  try {
    const upstream = await fetchPeer(peer.address, '/a2a-recv', req.body);
    const data = await (upstream as unknown as { json(): Promise<unknown> }).json();
    peer.online = true;
    peer.lastSeen = Date.now();
    res.json(data);
  } catch {
    peer.online = false;
    res.status(503).json({ error: 'Peer unreachable', peer_id: peerId });
  }
});

app.post('/a2a-recv', (req: Request, res: Response) => {
  // Deliver to local queue so the agent can pick it up via /recv
  const body = req.body as Record<string, unknown>;
  inboundQueue.push({
    from: (body['from_peer'] as string | undefined) ?? 'unknown',
    data: Buffer.from(JSON.stringify({ type: 'a2a_call', payload: body })).toString('base64'),
    timestamp: Date.now(),
    message_id: randomUUID(),
  });
  res.json({
    type: 'a2a_response',
    from_peer: SELF_PEER_ID,
    request_id: body['request_id'],
    payload: { status: 'queued' },
  });
});

// ─── MCP forwarding ───────────────────────────────────────────────────────────

app.post('/mcp/:peerId/:service', async (req: Request, res: Response) => {
  const { peerId, service } = req.params;
  const peer = Array.from(peers.values()).find(p => p.peerId === peerId);

  if (!peer) {
    res.status(404).json({
      jsonrpc: '2.0',
      error: { code: -32601, message: `Unknown peer: ${peerId}` },
      id: (req.body as { id?: string }).id,
    });
    return;
  }

  try {
    const upstream = await fetchPeer(peer.address, `/mcp-serve/${service}`, req.body);
    const data = await (upstream as unknown as { json(): Promise<unknown> }).json();
    res.json(data);
  } catch {
    res.status(503).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Peer unreachable' },
      id: (req.body as { id?: string }).id,
    });
  }
});

app.post('/mcp-serve/:service', (req: Request, res: Response) => {
  res.json({
    jsonrpc: '2.0',
    result: { status: 'ok', service: req.params.service, role: ROLE },
    id: (req.body as { id?: string }).id,
  });
});

// ─── GossipSub ────────────────────────────────────────────────────────────────

app.post('/gossip/publish', async (req: Request, res: Response) => {
  const { topic, data } = req.body as { topic: string; data: string };
  const msg = { from: SELF_PEER_ID, data, timestamp: Date.now() };

  // Store locally
  const queue = gossipQueues.get(topic) ?? [];
  queue.push(msg);
  if (queue.length > 200) queue.shift();
  gossipQueues.set(topic, queue);

  // Fan-out
  const fanout = Array.from(peers.values()).map(peer =>
    fetchPeer(peer.address, '/gossip/receive', { topic, ...msg }).then(r => {
      if (r) { peer.online = true; peer.lastSeen = Date.now(); }
    }).catch(() => { peer.online = false; })
  );
  await Promise.allSettled(fanout);
  res.json({ success: true });
});

app.post('/gossip/receive', (req: Request, res: Response) => {
  const { topic, from, data, timestamp } = req.body as {
    topic: string; from: string; data: string; timestamp: number;
  };
  const queue = gossipQueues.get(topic) ?? [];
  queue.push({ from, data, timestamp });
  if (queue.length > 200) queue.shift();
  gossipQueues.set(topic, queue);
  res.json({ success: true });
});

app.get('/gossip/messages/:topic', (req: Request, res: Response) => {
  const topic = req.params.topic;
  const messages = (gossipQueues.get(topic) ?? []).splice(0);
  gossipQueues.set(topic, []);
  res.json({ messages });
});

// ─── Convergecast ─────────────────────────────────────────────────────────────

app.post('/convergecast', async (req: Request, res: Response) => {
  const { topic, data, aggregation_fn } = req.body as {
    topic: string; data: string; aggregation_fn: string;
  };

  let results: unknown[] = [];
  try {
    results.push(JSON.parse(Buffer.from(data, 'base64').toString('utf8')));
  } catch { /* ignore decode error */ }

  const requests = Array.from(peers.values()).map(async peer => {
    try {
      const upstream = await fetchPeer(peer.address, '/convergecast-recv', { topic, data, aggregation_fn });
      const result = await (upstream as unknown as { json(): Promise<{ data?: string }> }).json();
      if (result.data) {
        results.push(JSON.parse(Buffer.from(result.data, 'base64').toString('utf8')));
      }
    } catch { /* peer offline */ }
  });

  await Promise.allSettled(requests);
  res.json({
    topic,
    aggregated: Buffer.from(JSON.stringify(results)).toString('base64'),
    contributor_count: results.length,
  });
});

app.post('/convergecast-recv', (req: Request, res: Response) => {
  res.json({ data: (req.body as { data?: string }).data });
});

// ─── Health ───────────────────────────────────────────────────────────────────

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', role: ROLE, peerId: SELF_PEER_ID, peers: peers.size });
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

parsePeers();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[AXL:${ROLE}] broker running on :${PORT} — peer_id=${SELF_PEER_ID}`);
  console.log(`[AXL:${ROLE}] known peers: ${Array.from(peers.keys()).join(', ') || 'none'}`);

  // Perform peer handshake after a short delay (let other containers start)
  setTimeout(async () => {
    for (const peer of peers.values()) {
      try {
        const res = await fetch(`http://${peer.address}/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            peer_id: SELF_PEER_ID,
            role: ROLE,
            address: `axl-${ROLE}:${PORT}`,
          }),
          signal: AbortSignal.timeout(5000),
        });
        const json = await res.json() as { peer_id: string };
        peer.peerId = json.peer_id;
        peer.online = true;
        peer.lastSeen = Date.now();
        console.log(`[AXL:${ROLE}] Handshake OK with ${peer.role} (${json.peer_id.slice(0, 16)})`);
      } catch (err) {
        console.warn(`[AXL:${ROLE}] Handshake failed with ${peer.role}: ${err}`);
      }
    }
  }, 5000);
});
