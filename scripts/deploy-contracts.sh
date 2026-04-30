#!/usr/bin/env bash
# deploy-contracts.sh — Compile and deploy all three ADVERSA contracts to 0G Chain testnet
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTRACTS_DIR="$ROOT/contracts"
ENV_FILE="$ROOT/.env"

echo "==> ADVERSA Contract Deployment"
echo "    Network: 0G Chain Testnet (chainId 16602)"
echo "    RPC: ${OG_RPC_URL:-https://evmrpc-testnet.0g.ai}"
echo ""

# ── Preflight checks ────────────────────────────────────────────────────────

if [[ -z "${DEPLOYER_PRIVATE_KEY:-}" ]]; then
  echo "ERROR: DEPLOYER_PRIVATE_KEY not set"
  echo "  Export it or add it to $ENV_FILE"
  exit 1
fi

if [[ ! -d "$CONTRACTS_DIR/node_modules" ]]; then
  echo "==> Installing contract dependencies..."
  (cd "$CONTRACTS_DIR" && npm install)
fi

# ── Compile ─────────────────────────────────────────────────────────────────

echo "==> Compiling contracts..."
(cd "$CONTRACTS_DIR" && npx hardhat compile)
echo "    Compiled successfully."

# ── Deploy ──────────────────────────────────────────────────────────────────

echo ""
echo "==> Deploying to 0G Chain testnet..."
(cd "$CONTRACTS_DIR" && npx hardhat run scripts/deploy.ts --network 0g-testnet)

# ── Read deployment.json and print addresses ────────────────────────────────

DEPLOYMENT="$CONTRACTS_DIR/deployment.json"
if [[ -f "$DEPLOYMENT" ]]; then
  echo ""
  echo "==> Deployed contract addresses:"
  node -e "
    const d = require('$DEPLOYMENT');
    console.log('  AdversaRegistry:   ' + d.registry);
    console.log('  AdversaReputation: ' + d.reputation);
    console.log('  AdversaINFT:       ' + d.inft);
    console.log('  Network:           ' + d.network);
    console.log('  Block:             ' + d.blockNumber);
  "

  echo ""
  echo "==> Addresses written to .env"
  echo "    Restart agents to pick up new contract addresses."
else
  echo "WARNING: deployment.json not found — check deploy script output above."
fi

echo ""
echo "Done."
