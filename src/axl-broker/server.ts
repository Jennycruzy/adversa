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
 *   POST /mcp/:peerId/:service       — MCP call (forwarded via /deliver)
 *   POST /gossip/publish             — fan-out to all peers
 *   POST /gossip/receive             — receive gossip (internal)
 *   GET  /gossip/messages/:topic     — drain gossip queue for topic
 *   POST /convergecast               — collect from all peers
 *   POST /convergecast-recv          — receive convergecast (internal)
 *   POST /register                   — peer handshake
 *   GET  /health                     — liveness probe
 */

import express, { Request, Response } from 'express';
import { randomBytes, createHash, randomUUID } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';

const app = express();
app.use(express.json({ limit: '4mb' }));

const ROLE = process.env.AGENT_ROLE ?? 'gateway';
const PORT = parseInt(process.env.AXL_NODE_PORT ?? '9002');

// ─── Stable peer ID ───────────────────────────────────────────────────────────
//
// The peer ID must survive container restarts so topology bookkeeping in
// other brokers stays consistent. We derive it from a 32-byte seed stored
// in AXL_PRIVATE_KEY_PATH. On first boot the seed is generated and persisted;
// subsequent starts load the same seed, producing the same peer ID.

function loadOrCreateNodeSeed(keyPath: string): string {
  const dir = path.dirname(keyPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (existsSync(keyPath)) {
    const seed = readFileSync(keyPath, 'utf8').trim();
    if (seed.length >= 32) return seed;
  }
  const seed = randomBytes(32).toString('hex');
  writeFileSync(keyPath, seed, { mode: 0o600 });
  return seed;
}

const KEY_PATH = process.env.AXL_PRIVATE_KEY_PATH ?? './keys/peer-id.key';
const nodeSeed = loadOrCreateNodeSeed(KEY_PATH);
const SELF_PEER_ID = `${ROLE}-${createHash('sha256').update(nodeSeed).digest('hex').slice(0, 16)}`;

// ─── State ────────────────────────────────────────────────────────────────────

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
// gossipQueues: topic → messages; cap at 500 per topic
const gossipQueues = new Map<string, Array<{ from: string; data: string; timestamp: number }>>();
// seen gossip fingerprints for deduplication (from:topic:ts)
const seenGossip = new Set<string>();
const GOSSIP_DEDUP_TTL_MS = 30_000;
const GOSSIP_QUEUE_MAX = 500;

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
//
// A2A calls are fully message-based: the caller sends an a2a_call message via
// /send, then polls /recv for the a2a_response (correlated by request_id).
// The /a2a/:peerId HTTP endpoint is kept for compatibility but simply delivers
// the call as a message and returns an acknowledgment — the real response
// arrives asynchronously through the message queue.

app.post('/a2a/:peerId', async (req: Request, res: Response) => {
  const { peerId } = req.params;
  const peer = Array.from(peers.values()).find(p => p.peerId === peerId);

  if (!peer) {
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
//
// /mcp/:peerId/:service delivers the call as a message into the target broker's
// inbound queue. The target agent picks it up via /recv, calls handleMCPCall(),
// and sends the response back via /send (which delivers to the caller's queue).
// The caller's AXLClient.startPolling() intercepts the mcp_response by request_id.

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

  // Wrap the JSON-RPC body as an mcp_call message and deliver it
  const body = req.body as { method?: string; params?: Record<string, unknown>; id?: string };
  const message: Message = {
    from: SELF_PEER_ID,
    data: Buffer.from(JSON.stringify({
      type: 'mcp_call',
      service,
      method: body.method ?? service,
      params: body.params ?? {},
      request_id: body.id ?? randomUUID(),
    })).toString('base64'),
    timestamp: Date.now(),
    message_id: randomUUID(),
  };

  try {
    await fetchPeer(peer.address, '/deliver', message);
    peer.online = true;
    peer.lastSeen = Date.now();
    // ACK — caller polls /recv for the actual mcp_response keyed by request_id
    res.json({ jsonrpc: '2.0', result: { status: 'queued' }, id: body.id });
  } catch {
    peer.online = false;
    res.status(503).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Peer unreachable' },
      id: body.id,
    });
  }
});

// ─── GossipSub ────────────────────────────────────────────────────────────────

function gossipFingerprint(from: string, topic: string, timestamp: number): string {
  return `${from}:${topic}:${timestamp}`;
}

function enqueueGossip(topic: string, msg: { from: string; data: string; timestamp: number }): void {
  const fp = gossipFingerprint(msg.from, topic, msg.timestamp);
  if (seenGossip.has(fp)) return; // deduplicate
  seenGossip.add(fp);
  // Evict old fingerprints to bound memory
  if (seenGossip.size > 5000) {
    const first = seenGossip.values().next().value;
    if (first !== undefined) seenGossip.delete(first);
  }
  const queue = gossipQueues.get(topic) ?? [];
  queue.push(msg);
  if (queue.length > GOSSIP_QUEUE_MAX) queue.shift();
  gossipQueues.set(topic, queue);
  // Schedule fingerprint expiry
  setTimeout(() => seenGossip.delete(fp), GOSSIP_DEDUP_TTL_MS);
}

app.post('/gossip/publish', async (req: Request, res: Response) => {
  const { topic, data } = req.body as { topic: string; data: string };
  const msg = { from: SELF_PEER_ID, data, timestamp: Date.now() };

  enqueueGossip(topic, msg);

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
  enqueueGossip(topic, { from, data, timestamp });
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
  console.log(`[AXL:${ROLE}] key: ${KEY_PATH}`);
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
