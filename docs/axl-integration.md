# Gensyn AXL Integration Deep Dive

## What AXL Provides

AXL is Gensyn's encrypted P2P mesh built on Yggdrasil with ed25519 node identities. ADVERSA uses every AXL feature:

| Feature       | ADVERSA Usage                                          |
|---------------|--------------------------------------------------------|
| P2P messaging | Base agent message loop (send/recv with polling)       |
| MCP routing   | Fan-out review work to specialist agents               |
| A2A           | Adversarial debate between red-team and security       |
| GossipSub     | PR announcements, critical vuln broadcasts, heartbeats |
| Topology      | Peer discovery, role-based routing                     |
| Convergecast  | Spanning-tree vote aggregation for consensus           |

## Node Architecture

Each of the six agents runs on a **separate AXL node** with its own ed25519 keypair and port:

```
axl-gateway   localhost:9002   gateway agent
axl-security  localhost:9003   security agent
axl-perf      localhost:9004   performance agent
axl-style     localhost:9005   style agent
axl-redteam   localhost:9006   red-team agent
axl-coder     localhost:9007   coder agent
```

`scripts/setup-axl-nodes.sh` generates a unique keypair and `config.toml` for each node.

## HTTP API Endpoints Used

All AXL communication goes through the local HTTP API (`localhost:{port}/...`).

### Direct Messaging
```
POST /send
  Body: { "to": "<peer_id>", "data": "<base64_json>", "ttl": 30 }

GET  /recv
  Returns: [{ "from": "<peer_id>", "data": "<base64_json>", "timestamp": ... }]
```

Payloads are JSON-encoded then base64-wrapped before send; unwrapped and parsed on recv.

### Topology
```
GET /topology
  Returns: { "peers": [{ "peer_id": "...", "metadata": {...}, "connected": true }] }
```

`TopologyManager` polls every 5s and fires `agent-online` / `agent-offline` dashboard events on changes.

### MCP Routing
```
POST /mcp/<peer_id>/<service_name>
  Body: { "params": { ... } }
  Returns: { "result": { ... } }
```

Gateway fans out review work in parallel:
```typescript
const [secResult, perfResult, styleResult] = await Promise.all([
  axl.callMCP(securityPeer, 'security-scan', { diff, files, context }),
  axl.callMCP(perfPeer,     'performance-scan', { diff, files, context }),
  axl.callMCP(stylePeer,    'style-scan',   { diff, files, context }),
]);
```

### A2A (Agent-to-Agent)
```
POST /a2a/<peer_id>
  Body: { "payload": { "type": "exploit_challenge", ... } }
  Returns: { "type": "exploit_defense", ... }
```

Red-team sends exploit challenges to security; security responds with defense or concession.

### GossipSub
```
POST /gossip/publish
  Body: { "topic": "adversa:heartbeat", "data": "<base64_json>" }

GET  /gossip/messages/<topic>
  Returns: [{ "from": "...", "data": "<base64_json>", "seqno": "..." }]
```

Topics used:
- `adversa:pr-opened` — new PR available for review
- `adversa:critical-vuln` — unmitigated critical exploit found
- `adversa:goals` — natural-language task for coder agent
- `adversa:human-activity` — dashboard advisory vote received
- `adversa:heartbeat` — agent liveness (15s interval)

### Convergecast
```
POST /convergecast
  Body: { "value": { "approve": true, "agentId": "...", ... }, "timeout": 10 }
  Returns: { "values": [...] }  // aggregated from all peers
```

Used in Phase 5 to collect votes across the spanning tree without central coordination.

## Message Flow: MCP Review

```
gateway                     security peer
   │                              │
   │  POST /mcp/{peer}/security-scan
   │  { diff, files, context }    │
   │ ─────────────────────────── ►│
   │                              │  callLLM() → 0G Compute
   │                              │  parse findings JSON
   │                              │
   │  { findings[], summary, overallRisk }
   │ ◄─────────────────────────── │
   │                              │
```

## Message Flow: A2A Debate

```
redteam                     security
   │                              │
   │  POST /a2a/{secPeer}         │
   │  { type: "exploit_challenge" │
   │    exploit: { type, payload  │
   │    attackVector, ... } }     │
   │ ─────────────────────────── ►│
   │                              │  callLLM(defense prompt)
   │                              │
   │  { type: "exploit_defense"   │
   │    mitigated: false          │
   │    concession: "..." }       │
   │ ◄─────────────────────────── │
   │                              │
   │  // escalate: counter-attack │
   │  POST /a2a/{secPeer}         │
   │  { type: "exploit_challenge" │
   │    // more sophisticated }   │
   │ ─────────────────────────── ►│
```

## Message Deduplication

`GossipSub` maintains a `Set<string>` of seen message IDs with LRU eviction at 2000 entries. Each message is keyed by `${from}:${seqno}`. This prevents the same gossip message from being processed twice during the polling interval.

## BaseAgent Polling Architecture

```typescript
// Poll AXL inbox every 1 second
axl.startPolling(1000, msg => this.handleRawMessage(msg));

handleRawMessage(msg) {
  if (msg.type === 'mcp_call')  → handleMCPCall()  → send mcp_response
  if (msg.type === 'a2a_call')  → handleA2ACall()  → send a2a_response
}
```

Responses are sent back to the `from` peer with the original `request_id` for correlation.

## Implementing a New Agent

1. Extend `BaseAgent` in `src/agents/`
2. Implement the four abstract methods:
   - `onStart()` — one-time setup
   - `getSystemPrompt()` — LLM persona
   - `getMCPServices()` — declare MCP capabilities
   - `handleMCPCall(method, params)` — handle incoming MCP
   - `handleA2ACall(payload)` — handle A2A messages
3. Add an entry in `docker-compose.yml` with a new AXL node port
4. Add the role to `AgentRole` in `src/config.ts`

## Known Limitations

- AXL inbox polling is 1Hz; high-throughput debate rounds may see ~1s latency between exchanges
- Topology metadata is free-form; ADVERSA stores `role` in peer metadata but there is no schema enforcement
- GossipSub `seqno` is provided by AXL but treated as opaque bytes for deduplication
