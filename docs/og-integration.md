# 0G Labs Integration Deep Dive

ADVERSA integrates all three 0G Labs products: **Compute** (Sealed TEE Inference), **Storage** (decentralized blob store), and **Chain** (EVM-compatible L1).

---

## 0G Compute — Sealed TEE Inference

### What it does

0G Compute routes LLM inference through providers running inside Trusted Execution Environments (TEEs). Each response includes a cryptographic proof (`ZG-Res-Key`) that the model ran unmodified in a sealed enclave.

### SDK Integration

```typescript
// src/integrations/og-compute.ts
import { createZGServingNetworkBroker } from '@0glabs/0g-serving-broker';

// Initialize with signer
const broker = await createZGServingNetworkBroker(signer);

// Discover TeeML providers
const services = await broker.listService();
const teeProviders = services.filter(s => s.serviceType === 'teeml');

// Acknowledge the provider (one-time per session)
await broker.acknowledgeProviderSigner(provider.name, provider.providerAddress);

// Get request headers (fresh per call — contains payment proof)
const { endpoint, model } = provider;
const headers = await broker.getRequestHeaders(provider.name, provider.providerAddress, userMessage);

// Call OpenAI-compatible endpoint
const response = await openai.chat.completions.create(
  { model, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMessage }] },
  { headers }
);

// Verify TEE proof
const chatId = response.id;
const isValid = await broker.processResponse(provider.name, provider.providerAddress, chatId);
const teeProof = chatId; // used as opaque identifier throughout the system
```

### TEE Proof Chain

Every `callLLM()` call in `BaseAgent` returns `{ response, teeProof, isValid }`.

- `teeProof` (the chat ID / `ZG-Res-Key`) is attached to each `ReviewFinding`
- `isValid` gates whether the proof is included (mock mode sets `isValid: false`)
- All TEE proof IDs are aggregated in `ConsensusResult.teeProofIds`
- `KeeperHub` records the first proof ID on-chain in `AdversaRegistry`

### Mock Mode

When `OG_PRIVATE_KEY` is not set, `OGComputeClient` returns:
```json
{
  "response": "{\"findings\": [], \"summary\": \"Mock analysis...\", \"overallRisk\": \"low\"}",
  "teeProof": "mock-tee-proof-<uuid>",
  "isValid": false
}
```

This allows the full pipeline to run without a funded 0G account.

---

## 0G Storage — Decentralized Blob Store

### What it does

0G Storage provides content-addressed blob storage with Merkle tree proofs. Data is identified by its root hash — not a filename or server URL.

### SDK Integration

```typescript
// src/integrations/og-storage.ts
import { ZgFile, Indexer } from '@0gfoundation/0g-ts-sdk';

// Build file from JSON bytes
const jsonBytes = Buffer.from(JSON.stringify(data, null, 2));
const blob = new Blob([jsonBytes], { type: 'application/json' });
const file = await ZgFile.fromFilePath(tempPath);

// Compute Merkle tree — this is the content address
const [tree, treeErr] = await file.merkleTree();
const rootHash = tree.rootHash();

// Upload to 0G Storage network
const indexer = new Indexer(config.og.storageIndexerUrl);
const [txHash, uploadErr] = await indexer.upload(file, config.og.rpcUrl, signer);

// Permanent address
const url = `0g-storage://${rootHash}`;
```

### What Gets Stored

| Data            | Method                     | Content type        |
|-----------------|----------------------------|---------------------|
| Debate transcript | `uploadDebateTranscript()` | `debate-transcript` |
| Review findings | `uploadReviewFindings()`   | `review-findings`   |
| Agent intelligence | `uploadAgentIntelligence()` | `agent-intelligence` |

The root hash returned from storage upload is what gets recorded on 0G Chain — forming a verifiable link between the on-chain record and the full off-chain data.

### Addressing

```
0g-storage://<merkle-root-hash>
```

Anyone with the root hash can fetch the original blob and verify its integrity without trusting any server.

---

## 0G Chain — Smart Contracts

### Network Details

| Parameter | Value |
|-----------|-------|
| Chain ID  | 16602 |
| RPC URL   | https://evmrpc-testnet.0g.ai |
| Explorer  | https://chainscan-galileo.0g.ai |
| Currency  | A0GI (test tokens from faucet) |
| EVM version | Cancun |
| Solidity  | 0.8.24 |

### Contract Addresses

After deployment (`npm run deploy:contracts`), addresses are saved to `contracts/deployment.json` and auto-injected into `.env`.

### AdversaRegistry.sol

Immutable log of every review decision.

```solidity
function recordReview(
    bytes32 prHash,          // keccak256-like bytes32 of PR identifier
    address[] calldata reviewerAgents,  // agent peer IDs as addresses
    bool approved,           // consensus decision
    string calldata storageRoot,  // 0G Storage Merkle root hash
    string calldata teeProofId,   // 0G Compute TEE proof
    uint256 confidenceScore,      // basis points (0-10000)
    uint256 exploitsFound,        // total exploits attempted
    uint256 exploitsMitigated     // exploits that were defended
) external onlyApproved
```

- `onlyApproved` — only gateway contract address can call (set via `approveCaller()`)
- Emits `ReviewRecorded` event
- Custom errors: `ReviewAlreadyExists`, `ReviewNotFound`
- `getApprovalRate()` returns percentage of approved reviews

### AdversaReputation.sol

Tracks agent accuracy on-chain. Scoring:

| Event | Delta |
|-------|-------|
| Accurate review | +10 |
| Inaccurate review | -20 |
| Exploit found | +25 |
| False positive | -5 |

```solidity
function updateReputation(address agent, bool wasAccurate) external onlyReputationUpdater
function recordExploit(address agent, bool successful) external onlyReputationUpdater
function getAccuracyRate(address agent) external view returns (uint256)  // basis points
```

### AdversaINFT.sol — ERC-7857

Agent identity NFTs. Each agent is minted once and evolves as it learns.

```solidity
function mintAgent(
    address owner,
    string calldata encryptedURI,   // encrypted intelligence blob URI
    bytes32 metadataHash,           // hash of intelligence data
    string calldata role            // 'security' | 'redteam' | etc.
) external onlyOwner returns (uint256 tokenId)

function evolveAgent(
    uint256 tokenId,
    string calldata newEncryptedURI,
    bytes32 newMetadataHash
) external                          // called by KeeperHub after each learning cycle

function syncReputation(
    uint256 tokenId,
    uint256 newScore
) external onlyReputationContract   // called by reputation contract
```

The `encryptedURI` points to a 0G Storage blob containing the agent's system prompt, learned patterns, and version. In production this is encrypted so only the agent's private key can decrypt its own intelligence.

### Deployment

```bash
cd contracts
npx hardhat run scripts/deploy.ts --network 0g-testnet
```

Deploys in order: Registry → Reputation → iNFT, then wires them:
```
registry.approveCaller(gateway_address)
inft.setReputationContract(reputation_address)
reputation.setUpdater(gateway_address)
```

Output saved to `contracts/deployment.json`.

### Reading On-Chain Data

```typescript
// src/integrations/og-chain.ts
const registry = new ethers.Contract(registryAddress, REGISTRY_ABI, provider);

// Get review details
const review = await registry.getReview(prHashBytes32);
// → { approved, storageRoot, teeProofId, confidenceScore, timestamp, ... }

// Get approval rate
const rate = await registry.getApprovalRate();
// → BigInt in basis points

// Get agent reputation
const reputation = new ethers.Contract(reputationAddress, REPUTATION_ABI, provider);
const score = await reputation.getReputationScore(agentAddress);
```

---

## End-to-End Data Flow

```
PR arrives
    │
    ▼
0G Compute inference (×4 agents in parallel)
    │
    ▼  ZG-Res-Key (teeProof per finding)
    │
    ▼
Adversarial debate
    │
    ▼
ConsensusEngine
    │
    ├──► 0G Storage: upload findings blob → rootHash
    │
    └──► KeeperHub → 0G Chain: AdversaRegistry.recordReview(prHash, agents[], approved, rootHash, teeProof)
                  → 0G Chain: AdversaINFT.evolveAgent(tokenId, newURI)
                  → 0G Chain: AdversaReputation.updateReputation(agent, wasAccurate)
```

Every step is verifiable: TEE proofs are on-chain, storage content is hash-verified, the on-chain record links to the full transcript.
