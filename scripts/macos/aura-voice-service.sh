#!/bin/bash
# Launchd entry for Aura live-voice Mac services.
# Usage: aura-voice-service.sh <proxy|pipecat|cloudflared|monitor>
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
if [ -d "${HOME}/Library/Application Support/ifcdc-aura-voice" ]; then
  ROOT="${HOME}/Library/Application Support/ifcdc-aura-voice"
fi
cd "$ROOT"

if [ -s "${HOME}/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "${HOME}/.nvm/nvm.sh"
  nvm use --silent >/dev/null 2>&1 || true
fi

export PATH="/opt/homebrew/bin:/usr/local/bin:${HOME}/bin:${PATH}"
export VOICEBOX_PRIMARY="${VOICEBOX_PRIMARY:-0}"
export PIPECAT_ENABLED="${PIPECAT_ENABLED:-0}"
export VOICEBOX_UPSTREAM_URL="${VOICEBOX_UPSTREAM_URL:-http://127.0.0.1:17493}"
export VOICEBOX_TUNNEL_PROXY_HOST="${VOICEBOX_TUNNEL_PROXY_HOST:-127.0.0.1}"
export VOICEBOX_TUNNEL_PROXY_PORT="${VOICEBOX_TUNNEL_PROXY_PORT:-17494}"
export VOICEBOX_TUNNEL_SECRET_FILE="${VOICEBOX_TUNNEL_SECRET_FILE:-$ROOT/data/aura-voicebox-tunnel.secret}"
export VOICEBOX_TUNNEL_HOSTNAME="${VOICEBOX_TUNNEL_HOSTNAME:-aura-voice.ifcdcbarbersapp.com}"
export PIPECAT_SIDECAR_HOST="${PIPECAT_SIDECAR_HOST:-127.0.0.1}"
export PIPECAT_SIDECAR_PORT="${PIPECAT_SIDECAR_PORT:-8766}"

mkdir -p "$ROOT/data" "${HOME}/Library/Logs"

cmd="${1:-}"
case "$cmd" in
  proxy)
    exec node "$ROOT/auraVoiceboxTunnelProxy.cjs"
    ;;
  pipecat)
    exec python3 "$ROOT/tools/pipecat/sidecar.py"
    ;;
  cloudflared)
    CF="$(command -v cloudflared || true)"
    if [ -z "$CF" ]; then
      echo "[aura/cloudflared] cloudflared not installed. Founder: brew install cloudflared && cloudflared tunnel login"
      while true; do sleep 60; CF="$(command -v cloudflared || true)"; [ -n "$CF" ] && break; done
    fi
    CERT="${HOME}/.cloudflared/cert.pem"
    CFG="${HOME}/.cloudflared/ifcdc-aura-voicebox.yml"
    if [ ! -f "$CERT" ]; then
      echo "[aura/cloudflared] NOT READY — Founder must run: cloudflared tunnel login"
      echo "[aura/cloudflared] Dashboard: https://one.dash.cloudflare.com/ → Networks → Tunnels"
      while true; do
        sleep 30
        if [ -f "$CERT" ]; then
          echo "[aura/cloudflared] cert.pem appeared; ensuring named tunnel"
          bash "$ROOT/scripts/macos/aura-voicebox-ensure-tunnel.sh" || true
          break
        fi
      done
    fi
    if [ ! -f "$CFG" ]; then
      bash "$ROOT/scripts/macos/aura-voicebox-ensure-tunnel.sh" || true
    fi
    if [ ! -f "$CFG" ]; then
      echo "[aura/cloudflared] named tunnel config missing after ensure; waiting"
      while true; do sleep 30; [ -f "$CFG" ] && break; done
    fi
    exec "$CF" tunnel --config "$CFG" run
    ;;
  monitor)
    exec node "$ROOT/scripts/aura-voice-monitor.cjs"
    ;;
  *)
    echo "usage: $0 proxy|pipecat|cloudflared|monitor" >&2
    exit 2
    ;;
esac
