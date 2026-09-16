# AURA Voicebox production tunnel (Render → Founder Mac)

Production live calls stay **Polly**. `VOICEBOX_PRIMARY=0`. This tunnel is the secure path so Render can reach Sample A **later**, after a Founder final call test. Do not enable Voicebox globally.

Customer-facing name: **Aura**. Greeting: **Hi, this is Aura…** Never “Aura Allah”.

## Real architecture

```
Twilio call
  → Render (Aura brain, booking, PayPal, $0.99, Gather)
  → if VOICEBOX_PRIMARY=1 (OFF today): signed HTTPS to Cloudflare named tunnel
       → cloudflared on Founder Mac
       → allowlisted proxy 127.0.0.1:17494  (HMAC + timestamp + nonce)
       → Voicebox 127.0.0.1:17493  (admin NOT on the internet)
  → Twilio <Play> audio hosted on Render PUBLIC_API_URL
  → on tunnel/Mac/Pipecat/Voicebox/timeout/auth/health fail → Polly <Say>
```

Render env (dashboard, after Founder Cloudflare login):

| Variable | Value |
|---|---|
| `VOICEBOX_PRIMARY` | `0` (keep off) |
| `VOICEBOX_BASE_URL` | `https://aura-voice.ifcdcbarbersapp.com` |
| `VOICEBOX_TUNNEL_SECRET` | contents of Mac `data/aura-voicebox-tunnel.secret` (never git) |

Client sends `X-IFCDC-Timestamp`, `X-IFCDC-Nonce`, `X-IFCDC-Signature` (HMAC-SHA256). Proxy also accepts the shared secret with timestamp/nonce. Replay window 90s.

**Do not** set `VOICEBOX_BASE_URL=http://127.0.0.1:17493` on Render. That cannot work.

## What is exposed

Allowlisted on the proxy only:

- `GET /health` `/ready` `/models/status` (sanitized)
- `GET /profiles` (AURA founder-approved profile only)
- `POST /generate` `/generate/stream` `/speak` (allowlisted JSON keys)
- `GET /generate/:id/status` `GET /audio/:id` `GET /history/:id`
- `POST /generate/:id/cancel`

Denied: `/docs`, `/openapi.json`, `/health/filesystem`, `POST /models/load`, create/update/delete profiles, any filesystem or command path.

Proxy binds **127.0.0.1:17494**. cloudflared is the only public ingress. No `trycloudflare` hostname for production.

## Mac recovery (launchd)

```
bash scripts/install-aura-voice-mac.sh
```

Runtime is staged to `~/Library/Application Support/ifcdc-aura-voice` so launchd is not blocked by macOS Documents TCC. Agents (KeepAlive, RunAtLoad):

- `com.ifcdc.aura.voicebox-proxy`
- `com.ifcdc.aura.pipecat`
- `com.ifcdc.aura.cloudflared`
- `com.ifcdc.aura.voice-monitor`

Monitor reopens Voicebox.app if `/health` fails, kickstarts dropped agents, and **never writes `online: true` if Voicebox is down**. If the Mac is asleep/off, the tunnel connector dies and Render health fails → Polly. Heartbeat older than 25s is stale.

Pipecat sidecar stays on `127.0.0.1:8766` (not tunneled). `PIPECAT_ENABLED` default 0.

## Founder Cloudflare login (ONLY Founder stop)

Persistent named tunnels need a Cloudflare account (Free) and a zone. This repo cannot finish DNS without that login.

1. Create/sign in (Free): https://dash.cloudflare.com/sign-up
2. If `ifcdcbarbersapp.com` is not already a Cloudflare zone, **Add a site** → `ifcdcbarbersapp.com` → Free plan → set the nameservers Cloudflare shows. Wait until the zone is Active.
3. On the Founder Mac:

```bash
brew install cloudflared
cloudflared tunnel login
```

4. Browser opens Cloudflare **Authorize Tunnel**. Select the `ifcdcbarbersapp.com` zone (or the zone you will use). Confirm. This writes `~/.cloudflared/cert.pem`.

Dashboard equivalent (same login):

1. https://one.dash.cloudflare.com/
2. **Networks** → **Tunnels**
3. You can create tunnel `ifcdc-aura-voicebox` there, **or** skip and let the install script create it after CLI login.

5. Re-run:

```bash
bash scripts/install-aura-voice-mac.sh
```

That creates named tunnel `ifcdc-aura-voicebox` (stable UUID), writes `~/.cloudflared/ifcdc-aura-voicebox.yml`, and attempts:

```bash
cloudflared tunnel route dns ifcdc-aura-voicebox aura-voice.ifcdcbarbersapp.com
```

If DNS route fails, in the Cloudflare DNS dashboard add a **proxied CNAME**:

- Name: `aura-voice`
- Target: `<TUNNEL_UUID>.cfargotunnel.com`

6. Render dashboard for **aura-backend** and **ifcdc-barbers-backend696**:

- `VOICEBOX_PRIMARY=0`
- `VOICEBOX_BASE_URL=https://aura-voice.ifcdcbarbersapp.com`
- `VOICEBOX_TUNNEL_SECRET` = Mac file `data/aura-voicebox-tunnel.secret`

Do **not** put the secret in `render.yaml` values. Comments only.

## Latency

Streaming still starts **“Absolutely…”** / **“Claro que sí…”** when `PIPECAT_ENABLED=1` and primary is on. TTFB includes Cloudflare + proxy hop. Measure:

```bash
node scripts/measure-aura-founder-voice.mjs
VOICEBOX_BASE_URL=https://aura-voice.ifcdcbarbersapp.com VOICEBOX_TUNNEL_AUTH=1 node scripts/measure-aura-tunnel-ttfb.mjs
```

HE remains Polly fallback (not Sample A). EN/ES use Kokoro `af_heart`. Language switch keeps the booking ledger.

## After tunnel is authenticated

`PRODUCTION VOICE = READY FOR FOUNDER FINAL CALL TEST` — then **STOP**. Do not set `VOICEBOX_PRIMARY=1` globally.
