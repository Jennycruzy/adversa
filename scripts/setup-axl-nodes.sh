#!/usr/bin/env bash
set -euo pipefail

# ADVERSA — AXL Node Setup Script
# Builds AXL binary, generates ed25519 identity keys for each agent node,
# and writes node config files.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEYS_DIR="$SCRIPT_DIR/keys"
CONFIG_DIR="$SCRIPT_DIR/config"

AGENTS=(gateway security performance style redteam coder)
BASE_PORT=9002

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║          ADVERSA — AXL Node Setup               ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# ─── Install dependencies ─────────────────────────────────────────────────────
if ! command -v openssl &>/dev/null; then
  echo "❌ openssl is required. Install with: brew install openssl (macOS) or apt install openssl (Linux)"
  exit 1
fi

mkdir -p "$KEYS_DIR" "$CONFIG_DIR"

# ─── Build AXL binary (if not present) ───────────────────────────────────────
if [ ! -f "$SCRIPT_DIR/bin/axl" ]; then
  echo "📦 Building AXL binary from source..."
  if ! command -v go &>/dev/null; then
    echo "❌ Go is required to build AXL. Install from https://go.dev/dl/"
    echo "   Or download pre-built binary from: https://github.com/gensyn-ai/axl/releases"
    exit 1
  fi

  AXL_TMP=$(mktemp -d)
  git clone --depth 1 https://github.com/gensyn-ai/axl "$AXL_TMP/axl" 2>/dev/null || {
    echo "❌ Failed to clone AXL repo. Check network or clone manually."
    exit 1
  }
  cd "$AXL_TMP/axl"
  make build
  mkdir -p "$SCRIPT_DIR/bin"
  cp ./bin/axl "$SCRIPT_DIR/bin/axl"
  cd "$SCRIPT_DIR"
  rm -rf "$AXL_TMP"
  echo "✅ AXL binary built: $SCRIPT_DIR/bin/axl"
else
  echo "✅ AXL binary already present: $SCRIPT_DIR/bin/axl"
fi

# ─── Generate ed25519 key pairs ───────────────────────────────────────────────
echo ""
echo "🔑 Generating ed25519 identity keys for each agent..."
for agent in "${AGENTS[@]}"; do
  KEY_FILE="$KEYS_DIR/${agent}-private.pem"
  PUB_FILE="$KEYS_DIR/${agent}-public.pem"

  if [ -f "$KEY_FILE" ]; then
    echo "   ⏭  $agent keys already exist (skipping)"
    continue
  fi

  openssl genpkey -algorithm ed25519 -out "$KEY_FILE" 2>/dev/null
  openssl pkey -in "$KEY_FILE" -pubout -out "$PUB_FILE" 2>/dev/null
  chmod 600 "$KEY_FILE"
  echo "   ✅ $agent: $KEY_FILE"
done

# ─── Write node config files ──────────────────────────────────────────────────
echo ""
echo "⚙  Writing AXL node configs..."
PORT=$BASE_PORT
for agent in "${AGENTS[@]}"; do
  CONFIG_FILE="$CONFIG_DIR/node-config-${agent}.json"
  cat > "$CONFIG_FILE" << EOF
{
  "port": ${PORT},
  "private_key_path": "../../keys/${agent}-private.pem",
  "data_dir": "../../data/axl-${agent}",
  "peers": [
    "/dns4/localhost/tcp/9002"
  ],
  "agent_role": "${agent}",
  "log_level": "info"
}
EOF
  mkdir -p "$SCRIPT_DIR/data/axl-${agent}"
  echo "   ✅ $agent: port $PORT → $CONFIG_FILE"
  ((PORT++))
done

# ─── Write .env entry hints ───────────────────────────────────────────────────
echo ""
echo "📝 Add these to your .env file (one per agent startup):"
PORT=$BASE_PORT
for agent in "${AGENTS[@]}"; do
  echo "   # ${agent}: AXL_NODE_PORT=${PORT} AXL_CONFIG_PATH=./config/node-config-${agent}.json"
  ((PORT++))
done

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  Setup complete! Next: bash scripts/start-swarm.sh ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
