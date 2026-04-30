# KeeperHub Integration Deep Dive

## What KeeperHub Does

KeeperHub is a workflow automation layer for on-chain operations. Rather than calling smart contracts directly, ADVERSA submits structured **workflows** to KeeperHub which handles:

- Gas estimation and optimization
- Automatic retry with exponential backoff on congestion
- Nonce management across concurrent transactions
- Multi-RPC failover
- Full audit trail per workflow execution

This is critical for ADVERSA: the review pipeline may trigger multiple on-chain writes in parallel (record review + update reputation + evolve iNFT), and concurrent raw transactions from a single account would cause nonce collisions.

---

## Connection Architecture

Agents access KeeperHub via the AXL MCP gateway:

```
Agent ──► POST localhost:9002/mcp/{gateway_peer}/keeperhub
                    │
              gateway agent
                    │
              POST {KEEPERHUB_MCP_URL}/mcp
              X-API-Key: {KEEPERHUB_API_KEY}
                    │
              KeeperHub service
                    │
              0G Chain (chainId 16602)
```

The `KeeperHubClient` in `src/integrations/keeperhub.ts` calls the KeeperHub JSON-RPC endpoint directly when it is the caller (i.e., from the gateway). Downstream agents that need KeeperHub functionality send an MCP call to the gateway which proxies it.

---

## JSON-RPC Protocol

All KeeperHub calls use JSON-RPC 2.0 over HTTP POST:

```json
POST {KEEPERHUB_MCP_URL}/mcp
Content-Type: application/json
X-API-Key: {KEEPERHUB_MCP_API_KEY}

{
  "jsonrpc": "2.0",
  "method": "create_workflow",
  "params": { ... },
  "id": "<uuid>"
}
```

Response:
```json
{
  "jsonrpc": "2.0",
  "result": {
    "workflowId": "wf_abc123",
    "status": "queued"
  },
  "id": "<uuid>"
}
```

Error shape (when present):
```json
{
  "jsonrpc": "2.0",
  "error": { "code": -32603, "message": "..." },
  "id": "<uuid>"
}
```

---

## Workflow Definitions

### 1. Record Review on 0G Chain

Triggered after every review pipeline completes.

```typescript
await keeperhub.recordReviewOnChain(consensus, storageRoot, registryAddress);
```

Workflow:
```json
{
  "name": "adversa-record-review-{prHash[:16]}",
  "trigger": { "type": "webhook" },
  "retryPolicy": { "maxAttempts": 5, "backoffSeconds": 10 },
  "steps": [
    {
      "action": "web3.contract_write",
      "params": {
        "chain": "0g-testnet",
        "rpc_url": "https://evmrpc-testnet.0g.ai",
        "contract": "{registryAddress}",
        "abi_method": "recordReview(bytes32,address[],bool,string,string,uint256,uint256,uint256)",
        "args": [prHashBytes32, agentAddresses, approved, storageRoot, teeProofId, confidenceScore, exploitsFound, exploitsMitigated]
      }
    },
    {
      "action": "notification.log",
      "params": {
        "message": "Review APPROVED — PR {hash} — confidence 87%"
      }
    }
  ]
}
```

Retry policy: 5 attempts with 10s backoff — important because 0G testnet RPC can be congested.

### 2. Update Agent Reputation

```typescript
await keeperhub.updateReputation(agentAddress, wasAccurate, reputationAddress);
```

Workflow:
```json
{
  "name": "adversa-reputation-{agentAddr[:10]}-{timestamp}",
  "trigger": { "type": "webhook" },
  "retryPolicy": { "maxAttempts": 3, "backoffSeconds": 5 },
  "steps": [
    {
      "action": "web3.contract_write",
      "params": {
        "abi_method": "updateReputation(address,bool)",
        "args": [agentAddress, wasAccurate]
      }
    }
  ]
}
```

### 3. Mint Agent iNFT

Called once per agent on first deployment.

```typescript
await keeperhub.mintAgentINFT(ownerAddress, encryptedURI, metadataHash, role, inftAddress);
```

ABI method: `mintAgent(address,string,bytes32,string)`

### 4. Evolve Agent iNFT

Called after each review cycle when the agent's learned patterns update.

```typescript
await keeperhub.evolveAgentINFT(tokenId, newEncryptedURI, newMetadataHash, inftAddress);
```

ABI method: `evolveAgent(uint256,string,bytes32)`

### 5. Fund 0G Compute Account

Transfers A0GI to an inference account.

```typescript
await keeperhub.fundComputeAccount(fromAddress, toAddress, "0.1");
```

Action: `web3.transfer` (native token, not contract call)

---

## Workflow Status Polling

```typescript
const status = await keeperhub.getWorkflowStatus(workflowId);
// → { workflowId, status: 'queued' | 'running' | 'completed' | 'failed', txHash? }
```

ADVERSA currently fire-and-forgets workflows (logs the `workflowId` but does not poll). A production system would poll until `completed` or emit a dashboard event on `failed`.

---

## Docker Setup

```yaml
# docker-compose.yml
keeperhub-mcp:
  image: keeperhub/mcp-server:latest
  ports:
    - "8080:8080"
  environment:
    - KEEPERHUB_API_KEY=${KEEPERHUB_API_KEY}
    - SUPPORTED_CHAINS=0g-testnet
    - LOG_LEVEL=info
```

Set in `.env`:
```
KEEPERHUB_MCP_URL=http://localhost:8080
KEEPERHUB_API_KEY=your_key_here
KEEPERHUB_MCP_API_KEY=your_mcp_key_here
```

---

## Mock Mode

When `KEEPERHUB_MCP_API_KEY` is not set, `KeeperHubClient` returns a mock workflow result:

```json
{
  "workflowId": "mock-<uuid>",
  "status": "queued"
}
```

The pipeline continues normally — the mock satisfies the interface so all downstream code runs unchanged.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `KEEPERHUB_MCP_URL` | Yes | KeeperHub MCP server URL |
| `KEEPERHUB_API_KEY` | For real txs | REST API key |
| `KEEPERHUB_MCP_API_KEY` | For real txs | MCP JSON-RPC key |

`KEEPERHUB_API_KEY` enables initialization logging. `KEEPERHUB_MCP_API_KEY` gates actual HTTP calls — these may be the same value depending on KeeperHub's auth model.

---

## Integration Points in Pipeline

```
src/review/pipeline.ts  Phase 6:
  │
  ├── ogStorage.uploadReviewFindings(findings)  → storageRoot
  │
  ├── keeperhub.recordReviewOnChain(consensus, storageRoot, registryAddr)
  │      retries: 5 × 10s backoff
  │
  ├── keeperhub.updateReputation(agentAddr, wasAccurate, reputationAddr)
  │      retries: 3 × 5s backoff
  │
  └── keeperhub.evolveAgentINFT(tokenId, newURI, metadataHash, inftAddr)
         retries: 3 × 15s backoff
```

---

## Honest Feedback

See [FEEDBACK.md](../FEEDBACK.md) for a candid account of friction points encountered during integration, including: the lack of a local mock server, unclear workflow ID lifecycle semantics, manual ABI encoding requirements, and inconsistent error shapes. These are submitted as part of the KeeperHub bounty requirement.
