#!/usr/bin/env bash
set -euo pipefail

# ADVERSA — Launch full agent swarm
# Starts one AXL node per agent (separate processes), then starts each agent.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AXL_BIN="$SCRIPT_DIR/bin/axl"
PIDS_FILE="$SCRIPT_DIR/data/swarm.pids"
LOG_DIR="$SCRIPT_DIR/data/logs"

AGENTS=(gateway security performance style redteam coder)
BASE_AXL_PORT=9002

mkdir -p "$LOG_DIR" "$SCRIPT_DIR/data"

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║         ADVERSA — Starting Swarm                ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# ─── Stop any existing swarm ──────────────────────────────────────────────────
if [ -f "$PIDS_FILE" ]; then
  echo "🛑 Stopping existing swarm..."
  while IFS= read -r pid; do
    kill "$pid" 2>/dev/null || true
  done < "$PIDS_FILE"
  rm -f "$PIDS_FILE"
  sleep 2
fi

> "$PIDS_FILE"

# ─── Start AXL nodes ─────────────────────────────────────────────────────────
echo "🌐 Starting AXL nodes..."

if [ ! -f "$AXL_BIN" ]; then
  echo "❌ AXL binary not found at $AXL_BIN"
  echo "   Run: bash scripts/setup-axl-nodes.sh first"
  exit 1
fi

PORT=$BASE_AXL_PORT
for agent in "${AGENTS[@]}"; do
  CONFIG="$SCRIPT_DIR/config/node-config-${agent}.json"
  LOG="$LOG_DIR/axl-${agent}.log"

  "$AXL_BIN" \
    --config "$CONFIG" \
    --port "$PORT" \
    > "$LOG" 2>&1 &

  AXL_PID=$!
  echo "$AXL_PID" >> "$PIDS_FILE"
  echo "   ✅ axl-${agent}: port $PORT, pid $AXL_PID"
  ((PORT++))
done

echo "   ⏳ Waiting for AXL mesh to form..."
sleep 4

# ─── Start agent processes ────────────────────────────────────────────────────
echo ""
echo "🤖 Starting agent processes..."

PORT=$BASE_AXL_PORT
for agent in "${AGENTS[@]}"; do
  LOG="$LOG_DIR/agent-${agent}.log"

  env \
    AGENT_ROLE="$agent" \
    AXL_NODE_PORT="$PORT" \
    AXL_CONFIG_PATH="$SCRIPT_DIR/config/node-config-${agent}.json" \
    ts-node "$SCRIPT_DIR/src/index.ts" \
    > "$LOG" 2>&1 &

  AGENT_PID=$!
  echo "$AGENT_PID" >> "$PIDS_FILE"
  echo "   ✅ agent-${agent}: port $PORT, pid $AGENT_PID → $LOG"
  ((PORT++))
done

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  Swarm started! Dashboard: http://localhost:3001 ║"
echo "║  Logs: tail -f data/logs/agent-gateway.log       ║"
echo "║  Stop: kill \$(cat data/swarm.pids)               ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
