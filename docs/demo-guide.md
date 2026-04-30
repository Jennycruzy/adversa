# ADVERSA Demo Guide

A beat-by-beat script for the 3-minute ETHGlobal OpenAgents hackathon demo. Designed for one presenter with a laptop and a judge's phone.

---

## Pre-Demo Checklist

**15 minutes before:**
- [ ] `docker compose up -d` — all 13 containers running
- [ ] `npm run dev` in `adversa/` — gateway agent started, dashboard on :3000
- [ ] Open dashboard in browser: `http://localhost:3000`
- [ ] Load QR code tab — confirm URL shows local IP (not localhost)
- [ ] Judge scans QR code with phone — confirm mobile dashboard loads
- [ ] Have a test PR URL ready (or use the trigger button)
- [ ] Confirm 0G testnet faucet topped up: `OG_PRIVATE_KEY` has A0GI balance

**Env vars needed for live demo:**
```
OG_PRIVATE_KEY=<funded key>
OG_RPC_URL=https://evmrpc-testnet.0g.ai
GITHUB_TOKEN=<token with repo access>
GITHUB_REPO=<owner/repo>
KEEPERHUB_MCP_URL=http://localhost:8080
KEEPERHUB_MCP_API_KEY=<key>
```

---

## Demo Script (3 minutes)

### [0:00 – 0:20] The Pitch

> "Most AI code review tools are a single model rubber-stamping PRs. ADVERSA is a swarm — six AI agents that argue with each other before reaching consensus. One of them is specifically trying to break the code. Let me show you."

Point at the Mesh tab — show the live topology canvas with 6 nodes.

### [0:20 – 0:45] Trigger a Review

**Option A** — GitHub webhook (if repo is configured):
> "A PR just opened on GitHub. Watch what happens."

**Option B** — Dashboard trigger:
1. Click **Control** tab
2. Paste a Git diff or PR URL into the trigger field
3. Click **Trigger Review**

> "The gateway receives the PR and fans it out to all agents simultaneously over the AXL encrypted mesh."

Watch the **Pipeline** tab light up with Phase indicators.

### [0:45 – 1:15] The Adversarial Debate

Switch to the **Debate** tab.

> "This is the part that's different. The red-team agent — weighted 4x in consensus — is actively generating real exploit payloads against the diff."

Point at incoming attack messages (red background):
> "SQL UNION injection. Prototype pollution. JWT alg:none bypass. These aren't theoretical — the red-team agent crafted actual attack vectors using 0G's Sealed TEE Inference."

Point at defense messages (green background):
> "The security agent defends or concedes. If it concedes on a critical exploit, the PR is auto-rejected before voting even starts."

Show the TEE badge on messages:
> "Every LLM call has a cryptographic TEE proof. The ZG-Res-Key header proves the model ran unmodified in a sealed enclave."

### [1:15 – 1:40] Consensus & On-Chain Record

Watch the **Pipeline** tab reach Phase 5 → Phase 6.

> "Votes are aggregated via AXL convergecast — spanning-tree aggregation, no central coordinator. Weighted: redteam 4x, security 3x, performance 2x, style 1x."

Show the vote bar filling up.

> "Consensus reached. Now watch the on-chain record."

Switch to **Agents** tab — show the KeeperHub workflow firing.

> "KeeperHub is executing the registry write on 0G Chain. It handles gas, nonces, and retries so we don't nonce-collide when three writes fire in parallel."

> "The full debate transcript and findings are stored on 0G decentralized storage. The on-chain record has the Merkle root hash — anyone can fetch and verify the full transcript."

### [1:40 – 2:00] Judge Interaction — Mobile Advisory Vote

Hand the phone to the judge (or point at their screen).

> "You're now a human reviewer in the swarm. You have advisory weight — 2x in consensus. Cast your vote."

Judge taps Approve or Reject on the mobile dashboard.

> "That vote just propagated over AXL GossipSub to all agents. Human-in-the-loop, not human-in-the-way."

### [2:00 – 2:20] Inject a Goal — Coder Agent

Click **Control** tab → **Inject Goal** field.

Type: `"Add input validation to all API endpoints"`

Click **Send Goal**.

> "The coder agent receives natural-language goals over GossipSub, calls 0G Compute to generate an implementation, creates a branch, and opens a PR — which immediately goes back into the review pipeline."

> "The swarm reviews its own output. Dogfooding at the protocol level."

### [2:20 – 2:40] iNFT Evolution

> "Every agent is minted as an ERC-7857 iNFT on 0G Chain. When the red-team agent finds a successful exploit, its learned patterns are uploaded to 0G Storage, encrypted, and the iNFT evolves — the tokenURI updates to point to the new intelligence blob."

Show the iNFT section in the Agents tab (tokenId, role, evolution count).

> "The swarm gets smarter with every review. The intelligence is portable — you could transfer the iNFT to a different swarm and it brings its learned exploit patterns with it."

### [2:40 – 3:00] The Close

> "Six agents. Three blockchains. Real adversarial AI. Zero central servers."

> "AXL for the encrypted mesh. 0G Compute for TEE-verified inference. 0G Storage for tamper-proof transcripts. 0G Chain for the immutable registry. KeeperHub so three parallel transactions don't nonce-collide."

> "ADVERSA — adversarial AI code review, built for OpenAgents."

---

## Fallback: Offline Demo

If 0G testnet RPC is down or KeeperHub is unavailable:

1. The pipeline automatically queues on-chain operations to the offline queue
2. All AXL mesh activity, debate, and consensus still work fully
3. Dashboard shows queue depth and "Offline — queued for sync"
4. When connectivity restores, `SyncEngine.drain()` replays the queue

> "The review pipeline is fully offline-capable. Only the on-chain recording requires connectivity."

Toggle offline mode manually: Control tab → **Offline Mode** switch.

---

## Common Questions

**Q: Is the debate real or scripted?**
> Every LLM call hits 0G Compute with TEE verification. The ZG-Res-Key on each debate message is a real proof from the enclave.

**Q: What stops an agent from lying?**
> TEE proof is per-inference. The smart contract records the proof ID. Anyone can verify the response hash matches the on-chain record.

**Q: What's the consensus threshold?**
> 75% of weighted votes (7500 basis points). Any unmitigated critical exploit auto-rejects regardless of votes.

**Q: Can you add more agents?**
> Yes — extend `BaseAgent`, add a new AXL node in docker-compose, add the role to `AgentRole` in config. The pipeline discovers agents via AXL topology.

**Q: What's in the iNFT?**
> Encrypted 0G Storage URI → agent system prompt + learned patterns + version number. Encryption key held by the agent's owner. The on-chain token is the identity; the off-chain blob is the brain.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Agents not appearing in mesh | Check AXL node containers: `docker compose logs axl-security` |
| No TEE proofs | Ensure `OG_PRIVATE_KEY` has A0GI balance, check `og-compute` logs |
| KeeperHub workflows stuck in queued | Check `KEEPERHUB_MCP_API_KEY` is set, container is running |
| Mobile QR code unreachable | Phone and laptop must be on the same WiFi network |
| Compilation errors | Run `cd contracts && npx hardhat compile`; ensure Solidity 0.8.24 |
| TypeScript errors | Run `./node_modules/.bin/tsc --noEmit` from `adversa/` |
