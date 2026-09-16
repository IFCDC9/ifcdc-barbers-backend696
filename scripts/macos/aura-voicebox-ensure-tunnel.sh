#!/bin/bash
# Create or reuse the persistent named Cloudflare Tunnel (not trycloudflare).
# Requires: cloudflared tunnel login (Founder browser step).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NAME="${VOICEBOX_TUNNEL_NAME:-ifcdc-aura-voicebox}"
HOST="${VOICEBOX_TUNNEL_HOSTNAME:-aura-voice.ifcdcbarbersapp.com}"
PROXY_PORT="${VOICEBOX_TUNNEL_PROXY_PORT:-17494}"
CFDIR="${HOME}/.cloudflared"
CFG="${CFDIR}/${NAME}.yml"
export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH}"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "[aura/tunnel] cloudflared missing"
  exit 1
fi
if [ ! -f "${CFDIR}/cert.pem" ]; then
  echo "[aura/tunnel] NOT READY: run cloudflared tunnel login"
  exit 2
fi

mkdir -p "$CFDIR" "$ROOT/data"
STATE="$ROOT/data/aura-voicebox-tunnel.json"

list="$(cloudflared tunnel list 2>/dev/null || true)"
uuid=""
if echo "$list" | grep -q "$NAME"; then
  uuid="$(echo "$list" | awk -v n="$NAME" '$0 ~ n { print $1; exit }')"
fi
if [ -z "$uuid" ]; then
  echo "[aura/tunnel] creating named tunnel $NAME"
  create_out="$(cloudflared tunnel create "$NAME" 2>&1 || true)"
  echo "$create_out"
  uuid="$(echo "$create_out" | grep -Eo '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | tail -n 1 || true)"
  if [ -z "$uuid" ]; then
    list="$(cloudflared tunnel list 2>/dev/null || true)"
    uuid="$(echo "$list" | awk -v n="$NAME" '$0 ~ n { print $1; exit }')"
  fi
fi
if [ -z "$uuid" ]; then
  echo "[aura/tunnel] could not determine tunnel UUID"
  exit 3
fi

cred="${CFDIR}/${uuid}.json"
if [ ! -f "$cred" ]; then
  echo "[aura/tunnel] credentials file missing: $cred"
  exit 4
fi

echo "[aura/tunnel] routing $HOST → $NAME (idempotent)"
cloudflared tunnel route dns "$NAME" "$HOST" >/dev/null 2>&1 || \
  echo "[aura/tunnel] DNS route may already exist or the zone is not on Cloudflare. Founder: add CNAME ${HOST} → ${uuid}.cfargotunnel.com (proxied)."

cat > "$CFG" <<EOF
# IFCDC Aura Voicebox named tunnel — NEVER point at Voicebox 127.0.0.1:17493.
# Public traffic hits the allowlisted proxy only.
tunnel: ${uuid}
credentials-file: ${cred}
protocol: http2
ingress:
  - hostname: ${HOST}
    service: http://127.0.0.1:${PROXY_PORT}
    originRequest:
      noTLSVerify: true
      connectTimeout: 8s
      keepAliveTimeout: 90s
  - service: http_status:404
EOF

python3 - <<PY
import json, os
p = os.environ.get("STATE") or "${STATE}"
body = {
  "name": "${NAME}",
  "id": "${uuid}",
  "hostname": "${HOST}",
  "publicUrl": "https://${HOST}",
  "proxy": "http://127.0.0.1:${PROXY_PORT}",
  "upstream": "http://127.0.0.1:17493",
  "trycloudflare": False,
  "voiceboxPrimary": 0,
  "productionActivation": "OFF",
}
open(p, "w").write(json.dumps(body, indent=2) + "\n")
print("[aura/tunnel] wrote", p)
PY

echo "[aura/tunnel] VOICEBOX_BASE_URL=https://${HOST}"
echo "[aura/tunnel] Render: VOICEBOX_PRIMARY=0 and VOICEBOX_TUNNEL_SECRET from data/aura-voicebox-tunnel.secret"
