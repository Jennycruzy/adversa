#!/usr/bin/env bash
set -euo pipefail

# ADVERSA — End-to-end demo script
# Demonstrates: goal injection → code generation → PR → review → debate → merge

GATEWAY_URL="${GATEWAY_URL:-http://localhost:3001}"

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║            ADVERSA — Live Demo                      ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ─── Health check ─────────────────────────────────────────────────────────────
echo "1️⃣  Checking swarm health..."
STATUS=$(curl -sf "$GATEWAY_URL/api/status" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status','unknown'))" 2>/dev/null || echo "unreachable")
if [ "$STATUS" != "running" ]; then
  echo "❌ Gateway not reachable at $GATEWAY_URL"
  echo "   Start the swarm first: bash scripts/start-swarm.sh"
  exit 1
fi
echo "   ✅ Gateway: $GATEWAY_URL"

# ─── Open dashboard ───────────────────────────────────────────────────────────
echo ""
echo "2️⃣  Opening dashboard..."
if command -v open &>/dev/null; then
  open "$GATEWAY_URL"
elif command -v xdg-open &>/dev/null; then
  xdg-open "$GATEWAY_URL"
fi
echo "   ✅ Dashboard: $GATEWAY_URL"

# ─── Inject a demo goal ────────────────────────────────────────────────────────
echo ""
echo "3️⃣  Injecting demo goal via GossipSub..."
GOAL="Add input validation and rate limiting to the user registration endpoint to prevent brute force attacks"
RESPONSE=$(curl -sf -X POST "$GATEWAY_URL/api/inject-goal" \
  -H "Content-Type: application/json" \
  -d "{\"goal\": \"$GOAL\", \"source\": \"demo\"}" \
  2>/dev/null || echo '{"success":false}')

SUCCESS=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('success','false'))" 2>/dev/null || echo "false")
if [ "$SUCCESS" = "True" ] || [ "$SUCCESS" = "true" ]; then
  echo "   ✅ Goal injected: \"$GOAL\""
else
  echo "   ⚠️  Goal injection returned: $RESPONSE"
fi

echo ""
echo "4️⃣  Watch the pipeline in the dashboard!"
echo "   The coder agent will:"
echo "   - Write implementation code via 0G Compute"
echo "   - Open a GitHub PR"
echo "   - Broadcast to the AXL mesh"
echo ""
echo "   Then the swarm will:"
echo "   - Security agent: scan for vulnerabilities"
echo "   - Performance agent: analyze complexity"
echo "   - Style agent: check code quality"
echo "   - Red-team agent: generate exploits via A2A"
echo "   - Security agent: defend against exploits"
echo "   - Consensus: weighted vote via convergecast"
echo "   - Record on 0G Chain via KeeperHub"
echo ""
echo "5️⃣  Try the offline demo:"
echo "   - On your phone: scan the QR code in the dashboard Control tab"
echo "   - Click 'Kill Internet' on your phone"
echo "   - Inject another goal — watch it complete offline"
echo "   - Click 'Restore Internet' — queue drains automatically"
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  Demo ready! Watch the dashboard for live updates.  ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
