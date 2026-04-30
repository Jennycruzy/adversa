# KeeperHub Integration Feedback

Honest developer experience from integrating KeeperHub into ADVERSA during ETHGlobal OpenAgents hackathon.

---

## What We Built

ADVERSA routes all on-chain operations through KeeperHub:
- Recording review outcomes on AdversaRegistry (0G Chain)
- Updating agent reputation scores on AdversaReputation
- Minting and evolving agent iNFTs (ERC-7857)
- Funding 0G Compute accounts

The gateway agent exposes KeeperHub as an MCP service via AXL routing — other agents trigger on-chain operations without needing direct internet access.

---

## What Worked Well

**Workflow API design** — The create_workflow + trigger pattern maps cleanly to our use case. Being able to define retry policies per workflow (e.g., 5 retries for registry writes, 2 for ledger transfers) was exactly what we needed. Raw ethers.js gives you one shot; KeeperHub gives you resilience.

**Gas handling** — Not having to implement gas estimation + nonce management across 6 concurrent agent processes was a major relief. Nonce collisions are a real problem when multiple agents try to submit transactions in the same block. KeeperHub abstracts this entirely.

**Audit trail** — The per-workflow execution log is useful for the demo. We can show judges "here is every on-chain action ADVERSA has ever taken, with timestamps and tx hashes" without building that ourselves.

**MCP transport** — The JSON-RPC over HTTP interface made it straightforward to expose KeeperHub as an AXL MCP service. Agents on the mesh call `POST /mcp/{gateway_peer}/keeperhub` and never know they're talking to KeeperHub.

---

## Friction Points

**No local mock/dev mode.** During development, every workflow test hit the real KeeperHub API. This slowed iteration significantly — a local mock server that records workflow definitions and returns synthetic tx hashes would have saved hours. Docker Compose doesn't help because you still need real API keys.

**Workflow ID lifecycle is unclear.** After `create_workflow` succeeds, we get back a `workflowId`. If we call `create_workflow` again with the same name (e.g., on agent restart), it's not clear whether it creates a new workflow, updates the existing one, or errors. The docs imply names are unique but the behavior on collision is undocumented.

**Status polling gap.** `get_workflow_status` exists, but there's no push notification when a workflow completes. For the offline sync scenario (queue drains when internet restores), we need to know when the KeeperHub tx lands so we can show "Sync complete!" in the dashboard. We ended up polling every 5 seconds, which works but feels wrong.

**Error shape is inconsistent.** Some errors come back as `{ error: { message: string } }`, others as `{ error: string }`. We had to write defensive parsing in `keeperhub.ts` because we got burned by this in testing.

**The `web3.contract_write` step requires encoding ABI by hand** as a string (`'recordReview(bytes32,address[],bool,...)'`). We'd prefer passing the ABI array directly so KeeperHub can validate argument types before sending the transaction. We had a silent encoding bug with `bytes32` arguments that took 2 hours to debug.

**Documentation examples use placeholder chains.** Most examples show Ethereum mainnet or Polygon. Getting the 0G Chain testnet working required reading the source code to figure out how to pass `rpc_url` as an override. A section in the docs specifically for 0G Chain (chainId 16602, RPC https://evmrpc-testnet.0g.ai) would have been useful.

---

## Bugs Encountered

**Bug 1** — When `retryPolicy.maxAttempts` is 1, the workflow never retries after failure (expected: it should try once). Setting it to 2 when you want 1 retry is unintuitive. Reproducible: create a workflow with `maxAttempts: 1`, trigger it with an intentionally invalid contract address, observe it marks as `failed` without attempting.

**Bug 2** — The `notification.log` step occasionally returns 200 OK but the log entry doesn't appear in the workflow history. Seems to be a race condition in the logging pipeline. Non-blocking for us but confusing.

---

## Feature Requests

1. **Webhook callback on workflow completion.** Register a URL that KeeperHub POSTs to when a workflow finishes. Would eliminate polling and make the offline sync flow much cleaner.

2. **Dry-run mode.** `create_workflow` with `dry_run: true` should validate the ABI encoding and estimate gas without submitting. Essential for catching encoding bugs before they cost testnet tokens.

3. **Workflow templates.** Pre-defined workflow blueprints for common patterns (ERC-721 mint, ERC-20 transfer, arbitrary contract write). Reduces boilerplate and prevents encoding bugs.

4. **0G Chain in the docs.** Add a working example for 0G Chain testnet. The chain is production-ready and the 0G ecosystem is growing — early documentation investment pays off.

5. **Local development mode.** A `KEEPERHUB_DEV=true` flag that intercepts workflow calls and returns synthetic successful results. Would make unit testing dramatically easier.

---

## Summary

KeeperHub solved a real problem for ADVERSA — multi-agent concurrent on-chain writes are genuinely hard to get right, and KeeperHub handled it well once configured. The biggest wins were retry logic and nonce management. The biggest gaps are local development UX and documentation for non-Ethereum chains.

Would integrate KeeperHub in production. Would spend the first week lobbying for a local mock mode.
