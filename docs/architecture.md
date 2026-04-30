# ADVERSA System Architecture

## Overview

ADVERSA is a decentralized, adversarial AI code review swarm built for the ETHGlobal OpenAgents hackathon. Six specialized AI agents operate as independent AXL mesh nodes, debate code security via cryptographic message passing, reach weighted consensus, and record tamper-proof results on 0G Chain.

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        ADVERSA SWARM                             │
│                                                                  │
│  ┌──────────┐   AXL Mesh (P2P, ed25519)   ┌──────────────────┐  │
│  │  GitHub  │ ──── PR webhook ──────────► │ Gateway Agent    │  │
│  │   API    │ ◄─── merge/comment ──────── │ (port 9002)      │  │
│  └──────────┘                             └────────┬─────────┘  │
│                                                    │            │
│                                        MCP fan-out │            │
│                                   ┌───────┬────────┼────────┐   │
│                                   ▼       ▼        ▼        ▼   │
│                              Security  Perf     Style   RedTeam  │
│                              (9003)   (9004)   (9005)   (9006)  │
│                                                    │            │
│                                          A2A debate│            │
│                                                    ▼            │
│                              Security ◄──────── RedTeam         │
│                              (defend)   exploit   (attack)      │
│                                   │       challenge             │
│                                   ▼                             │
│                              Convergecast ──► Consensus          │
│                                   │                             │
│                                   ▼                             │
│                              Coder Agent ──► fix PR             │
│                              (port 9007)                        │
└──────────────────────────────────────────────────────────────────┘
          │                    │                    │
          ▼                    ▼                    ▼
    0G Compute           0G Storage           0G Chain
   (TEE inference)    (debate blobs)      (registry contract)
          │                                         │
          ▼                                         ▼
   ZG-Res-Key                               KeeperHub MCP
   (TEE proof)                            (reliable on-chain tx)
```

## Six-Phase Review Pipeline

```
Phase 0: PR arrives via GitHub webhook
          │
Phase 1: Topology discovery — map all live peers
          │
Phase 2: Parallel MCP fan-out
         ├── Security scan   (AXL MCP)
         ├── Performance scan (AXL MCP)
         ├── Style scan       (AXL MCP)
         └── Exploit scan     (AXL MCP)
                  │
Phase 3: A2A Adversarial Debate
         RedTeam ──exploit──► Security
         Security ──defense──► RedTeam
         (multi-round, escalating)
                  │
Phase 4: Human presence detection (advisory vote from dashboard)
                  │
Phase 5: Weighted vote aggregation
         ├── Build AgentVote[] from findings
         ├── Convergecast (spanning tree)
         └── ConsensusEngine (weighted tally)
                  │
Phase 6: Record & Act
         ├── GitHub: merge or requestChanges
         ├── 0G Storage: upload debate transcript + findings
         ├── KeeperHub: record on 0G Chain
         └── KeeperHub: evolve agent iNFTs
```

## Agent Roles and Weights

| Agent    | Port | Weight | Specialty                          |
|----------|------|--------|------------------------------------|
| gateway  | 9002 | —      | Orchestration, GitHub, dashboard   |
| security | 9003 | 3x     | OWASP/CWE vulnerability detection  |
| perf     | 9004 | 2x     | Algorithmic complexity, N+1, leaks |
| style    | 9005 | 1x     | Code quality, maintainability      |
| redteam  | 9006 | 4x     | Adversarial exploit generation     |
| coder    | 9007 | —      | Autonomous code generation         |

**Consensus formula:**
```
approveWeight = Σ (agentWeight × reputationMultiplier) for approving agents
threshold     = 7500 basis points (75%)
approved      = approveWeight / totalWeight ≥ threshold
```

Auto-reject: any unmitigated critical exploit from red-team bypasses voting.

## Data Flow — Storage

```
Review Pipeline
      │
      ├── debate transcript ──► 0G Storage (Merkle root hash)
      │                                │
      ├── findings + TEE proofs ──────►┤
      │                                │
      └── rootHash ──────────────────► 0G Chain (AdversaRegistry)
                                             │
                                             └── KeeperHub executes tx
```

## iNFT Lifecycle

```
First review ──► mintAgent(role, encryptedURI, metadataHash)
                     │
                     ▼
               AdversaINFT.sol (ERC-7857)
                     │
             After each accurate review:
                     ▼
            updateReputation() ──► evolveAgent(tokenId, newURI)
```

## Offline Architecture

```
ConnectivityDetector ──polls 0G RPC + GitHub──► online/offline signal
                                                          │
SyncEngine.executeOrQueue()                               │
      ├── online: execute immediately ◄──────────── online │
      └── offline: OfflineQueue (JSON file) ◄──── offline  │
                       │
                  Survives restarts
                       │
           When connectivity restores:
                       │
                  SyncEngine.drain() ──► replay in order ──► dashboard events
```

## Security Properties

- **Tamper-evident**: All findings stored with Merkle root hash on 0G Storage
- **TEE-verified**: Every LLM inference backed by ZG-Res-Key header proof
- **Adversarial**: Red-team actively attacks; consensus requires surviving exploit challenges
- **Cryptographic identity**: Each agent's ed25519 key is its AXL identity
- **On-chain audit**: `AdversaRegistry` stores every review result immutably

## Technology Stack

| Layer          | Technology                                        |
|----------------|---------------------------------------------------|
| P2P mesh       | Gensyn AXL (Yggdrasil + ed25519)                 |
| AI inference   | 0G Compute (Sealed TEE Inference)                 |
| Blob storage   | 0G Storage (ZgFile + Merkle tree)                 |
| Smart contracts| 0G Chain (chainId 16602, Solidity 0.8.24)         |
| iNFT standard  | ERC-7857 (AgentNFT with encrypted intelligence)   |
| On-chain relay | KeeperHub MCP (gas management + retry)            |
| GitHub         | Octokit REST (webhooks, comments, merge)          |
| Dashboard      | Express + Socket.IO + Canvas (real-time)          |
| Language       | TypeScript strict (Zod validation, no implicit any)|
| Containers     | Docker Compose (6 AXL + 6 agent + KeeperHub)     |
