#!/bin/bash
# Install Founder Mac launchd agents for Aura live-voice:
# cloudflared named tunnel, allowlisted Voicebox proxy, Pipecat sidecar, health monitor.
# Runtime is copied to ~/Library/Application Support so launchd is not blocked by Documents TCC.
# Does NOT set VOICEBOX_PRIMARY=1. Does NOT use trycloudflare for production.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LAUNCH="$HOME/Library/LaunchAgents"
LOGDIR="$HOME/Library/Logs"
STAGE="$HOME/Library/Application Support/ifcdc-aura-voice"
SECRET="$STAGE/data/aura-voicebox-tunnel.secret"
REPO_SECRET="$ROOT/data/aura-voicebox-tunnel.secret"
HOST="${VOICEBOX_TUNNEL_HOSTNAME:-aura-voice.ifcdcbarbersapp.com}"
export PATH="$HOME/bin:/opt/homebrew/bin:/usr/local/bin:${PATH}"
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh"
  nvm use --silent >/dev/null 2>&1 || true
fi

NODE_BIN="$(command -v node)"
PYTHON_BIN="$(command -v python3)"
CF_BIN="$(command -v cloudflared || true)"

mkdir -p "$LAUNCH" "$LOGDIR" "$ROOT/data" "$ROOT/macos/launchd" "$ROOT/macos/cloudflared"
mkdir -p "$STAGE/scripts/macos" "$STAGE/tools/pipecat" "$STAGE/data"
chmod +x "$ROOT/scripts/macos/aura-voice-service.sh" "$ROOT/scripts/macos/aura-voicebox-ensure-tunnel.sh"

if [ ! -s "$REPO_SECRET" ]; then
  SECRET_VAL="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
  umask 077
  printf "%s" "$SECRET_VAL" > "$REPO_SECRET"
  chmod 600 "$REPO_SECRET"
  echo "[aura/mac] wrote VOICEBOX_TUNNEL_SECRET file (not in git)"
else
  echo "[aura/mac] keeping existing tunnel secret file"
fi
cp "$REPO_SECRET" "$SECRET"
chmod 600 "$SECRET"

cp "$ROOT/auraVoiceboxTunnelProxy.cjs" "$STAGE/"
cp "$ROOT/auraVoiceboxTunnelAuth.cjs" "$STAGE/"
cp "$ROOT/auraVoiceboxTunnelStatus.cjs" "$STAGE/"
cp "$ROOT/scripts/aura-voice-monitor.cjs" "$STAGE/scripts/"
cp "$ROOT/scripts/macos/aura-voice-service.sh" "$STAGE/scripts/macos/"
cp "$ROOT/scripts/macos/aura-voicebox-ensure-tunnel.sh" "$STAGE/scripts/macos/"
cp "$ROOT/tools/pipecat/sidecar.py" "$STAGE/tools/pipecat/"
chmod +x "$STAGE/scripts/macos/"*.sh

if [ -z "$NODE_BIN" ]; then
  echo "[aura/mac] node not found on PATH"
  exit 1
fi
if [ -z "$PYTHON_BIN" ]; then
  echo "[aura/mac] python3 not found on PATH"
  exit 1
fi

write_plist() {
  local label="$1"
  shift
  local dest="$LAUNCH/${label}.plist"
  {
    cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>WorkingDirectory</key>
  <string>${STAGE}</string>
  <key>ProgramArguments</key>
  <array>
EOF
    for arg in "$@"; do
      printf '    <string>%s</string>\n' "$arg"
    done
    cat <<EOF
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${LOGDIR}/${label}.log</string>
  <key>StandardErrorPath</key>
  <string>${LOGDIR}/${label}.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${HOME}</string>
    <key>PATH</key>
    <string>${HOME}/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>VOICEBOX_PRIMARY</key>
    <string>0</string>
    <key>PIPECAT_ENABLED</key>
    <string>0</string>
    <key>VOICEBOX_TUNNEL_SECRET_FILE</key>
    <string>${SECRET}</string>
    <key>VOICEBOX_TUNNEL_HOSTNAME</key>
    <string>${HOST}</string>
    <key>VOICEBOX_UPSTREAM_URL</key>
    <string>http://127.0.0.1:17493</string>
    <key>VOICEBOX_TUNNEL_PROXY_HOST</key>
    <string>127.0.0.1</string>
    <key>VOICEBOX_TUNNEL_PROXY_PORT</key>
    <string>17494</string>
  </dict>
</dict>
</plist>
EOF
  } > "$dest"
  echo "[aura/mac] wrote $dest"
}

write_plist "com.ifcdc.aura.voicebox-proxy" "$NODE_BIN" "$STAGE/auraVoiceboxTunnelProxy.cjs"
write_plist "com.ifcdc.aura.pipecat" "$PYTHON_BIN" "$STAGE/tools/pipecat/sidecar.py"
write_plist "com.ifcdc.aura.voice-monitor" "$NODE_BIN" "$STAGE/scripts/aura-voice-monitor.cjs"
write_plist "com.ifcdc.aura.cloudflared" "/bin/bash" "$STAGE/scripts/macos/aura-voice-service.sh" "cloudflared"

cat > "$ROOT/macos/cloudflared/config.yml.example" <<EOF
# Persistent named tunnel (NOT trycloudflare).
# Public hostname → allowlisted proxy on 127.0.0.1:17494.
# NEVER ingress to Voicebox admin 127.0.0.1:17493.
tunnel: <TUNNEL_UUID>
credentials-file: /Users/<FOUNDER>/.cloudflared/<TUNNEL_UUID>.json
ingress:
  - hostname: ${HOST}
    service: http://127.0.0.1:17494
  - service: http_status:404
EOF

if [ -n "$CF_BIN" ]; then
  echo "[aura/mac] cloudflared already on PATH ($CF_BIN)"
else
  echo "[aura/mac] installing official cloudflared binary (not Homebrew source build)"
  ARCH="$(uname -m)"
  case "$ARCH" in
    arm64) CF_ASSET="cloudflared-darwin-arm64.tgz" ;;
    *) CF_ASSET="cloudflared-darwin-amd64.tgz" ;;
  esac
  TMP="$(mktemp -d)"
  if curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/${CF_ASSET}" -o "$TMP/cloudflared.tgz"; then
    tar -xzf "$TMP/cloudflared.tgz" -C "$TMP"
    mkdir -p "$HOME/bin"
    mv "$TMP/cloudflared" "$HOME/bin/cloudflared"
    chmod +x "$HOME/bin/cloudflared"
    echo "[aura/mac] installed $HOME/bin/cloudflared"
  else
    echo "[aura/mac] official binary download failed — Founder: brew install cloudflared or https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  fi
  rm -rf "$TMP"
fi
export PATH="$HOME/bin:/opt/homebrew/bin:/usr/local/bin:${PATH}"

UID_NUM="$(id -u)"
for label in com.ifcdc.aura.voicebox-proxy com.ifcdc.aura.pipecat com.ifcdc.aura.cloudflared com.ifcdc.aura.voice-monitor; do
  launchctl bootout "gui/${UID_NUM}/${label}" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/${UID_NUM}" "$LAUNCH/${label}.plist"
  launchctl enable "gui/${UID_NUM}/${label}" >/dev/null 2>&1 || true
  launchctl kickstart -k "gui/${UID_NUM}/${label}" >/dev/null 2>&1 || true
  echo "[aura/mac] loaded $label"
done

echo
echo "=== Aura live-voice Mac install ==="
echo "VOICEBOX_PRIMARY=0 (unchanged)"
echo "Runtime stage: $STAGE"
echo "Proxy: http://127.0.0.1:17494  (allowlisted, HMAC)"
echo "Voicebox admin stays: http://127.0.0.1:17493  (not tunneled)"
echo "Secret file: $SECRET"
echo "Intended public URL: https://${HOST}"
echo
if [ -f "${HOME}/.cloudflared/cert.pem" ]; then
  bash "$ROOT/scripts/macos/aura-voicebox-ensure-tunnel.sh" || true
  echo "Cloudflare cert present. Named tunnel ensure ran."
else
  echo "NOT READY: Cloudflare login is the only Founder stop."
  echo "1. Free Cloudflare account: https://dash.cloudflare.com/sign-up"
  echo "2. Add zone ifcdcbarbersapp.com (or another zone you control) if it is not already on Cloudflare."
  echo "3. On this Mac run:"
  echo "     cloudflared tunnel login"
  echo "   Browser opens → authorize the zone → cert saved to ~/.cloudflared/cert.pem"
  echo "4. Dashboard alternative: https://one.dash.cloudflare.com/ → Networks → Tunnels"
  echo "5. Re-run: bash scripts/install-aura-voice-mac.sh"
  echo "6. Render dashboard (do not put secrets in git):"
  echo "     VOICEBOX_PRIMARY=0"
  echo "     VOICEBOX_BASE_URL=https://${HOST}"
  echo "     VOICEBOX_TUNNEL_SECRET=<contents of $SECRET>"
fi
echo "Production TTS remains Polly until Founder final call test."
