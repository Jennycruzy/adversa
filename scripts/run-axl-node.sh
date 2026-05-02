#!/usr/bin/env sh
set -eu

KEY_PATH="${AXL_PRIVATE_KEY_PATH:-/app/keys/private.pem}"
CONFIG_PATH="${AXL_CONFIG_PATH:-/app/config/node-config.json}"
API_PORT="${AXL_NODE_PORT:-9002}"
BRIDGE_ADDR="${AXL_BRIDGE_ADDR:-0.0.0.0}"
TCP_PORT="${AXL_TCP_PORT:-7000}"
ROUTER_ADDR="${AXL_ROUTER_ADDR:-}"
ROUTER_PORT="${AXL_ROUTER_PORT:-9003}"
A2A_ADDR="${AXL_A2A_ADDR:-}"
A2A_PORT="${AXL_A2A_PORT:-9004}"
PEERS="${AXL_PEERS:-}"
LISTEN="${AXL_LISTEN:-}"

mkdir -p "$(dirname "$KEY_PATH")" "$(dirname "$CONFIG_PATH")"

if [ ! -s "$KEY_PATH" ]; then
  openssl genpkey -algorithm ed25519 -out "$KEY_PATH"
  chmod 600 "$KEY_PATH"
fi

json_array() {
  value="$1"
  if [ -z "$value" ]; then
    printf '[]'
    return
  fi

  printf '['
  first=1
  old_ifs="$IFS"
  IFS=','
  for item in $value; do
    trimmed="$(printf '%s' "$item" | sed 's/^ *//;s/ *$//')"
    [ -z "$trimmed" ] && continue
    if [ "$first" -eq 0 ]; then
      printf ','
    fi
    first=0
    printf '"%s"' "$trimmed"
  done
  IFS="$old_ifs"
  printf ']'
}

cat > "$CONFIG_PATH" <<EOF
{
  "PrivateKeyPath": "$KEY_PATH",
  "Peers": $(json_array "$PEERS"),
  "Listen": $(json_array "$LISTEN"),
  "api_port": $API_PORT,
  "bridge_addr": "$BRIDGE_ADDR",
  "tcp_port": $TCP_PORT,
  "router_addr": "$ROUTER_ADDR",
  "router_port": $ROUTER_PORT,
  "a2a_addr": "$A2A_ADDR",
  "a2a_port": $A2A_PORT
}
EOF

exec axl-node -config "$CONFIG_PATH"
