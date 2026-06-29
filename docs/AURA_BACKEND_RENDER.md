# aura-backend on Render — configuration fix

## Problem

`aura-backend` was connected to the **wrong repository** (`IFCDC9/ifcdc-barbers-backend`) and redeploying **client-only commits** (e.g. `cd43717` — `/invite` React route). That is a **frontend** change, not the AURA API.

AURA (chat, voice, Twilio) lives in the **repo root** `server.js` — same codebase as `ifcdc-barbers-backend696`, **not** `client/`.

## Correct configuration

| Setting | Value |
|---------|--------|
| **Repository** | `https://github.com/IFCDC9/ifcdc-barbers-backend696.git` |
| **Branch** | `main` |
| **Root directory** | *(empty — repo root)* **NOT** `client` |
| **Runtime** | Node |
| **Build command** | `npm install && npm run build` |
| **Start command** | `npm start` → `node server.js` |
| **Health check** | `/api/aura/status` |
| **Port** | `process.env.PORT` (Render sets automatically; server listens on `0.0.0.0`) |

### Build filter (recommended)

Ignore frontend-only paths so client commits do not trigger aura-backend deploys:

- **Ignored:** `client/**`, `mobile/**`, `frontend/**`

## Required environment variables

Copy from `ifcdc-barbers-backend696` (same Postgres + Twilio + OpenAI):

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Postgres (bookings, AURA chat history) |
| `OPENAI_API_KEY` | AURA chat + voice AI |
| `TWILIO_ACCOUNT_SID` | Voice + SMS |
| `TWILIO_AUTH_TOKEN` | Voice + SMS |
| `TWILIO_PHONE_NUMBER` | Outbound caller ID |
| `TWILIO_MESSAGING_SERVICE_SID` | SMS (optional) |
| `JWT_SECRET` | Auth for protected routes |
| `PUBLIC_BASE_URL` | `https://aura-backend.onrender.com` (this service URL) |
| `NODE_ENV` | `production` |
| `SKIP_VITE_ENV_VALIDATION` | `true` (backend-only service) |

**Do not** set `rootDir: client` or build the Vite SPA on this service.

## Fix via script (recommended)

```bash
export RENDER_API_KEY=rnd_...   # Render → Account → API Keys
node scripts/render-fix-aura-backend.mjs --deploy
node scripts/verify-aura-backend.mjs --base https://aura-backend.onrender.com
```

## Fix via Render Dashboard (manual)

1. Open **aura-backend** → **Settings**
2. **Repository** → `ifcdc-barbers-backend696` (not `ifcdc-barbers-backend`)
3. **Root Directory** → clear / leave empty
4. **Build Command** → `npm install && npm run build`
5. **Start Command** → `npm start`
6. **Health Check Path** → `/api/aura/status`
7. **Build & Deploy** → add ignored paths: `client/**`, `mobile/**`
8. **Environment** → set `PUBLIC_BASE_URL` to this service’s `.onrender.com` URL
9. **Manual Deploy** → Deploy latest commit from `main` (do **not** redeploy `cd43717` from the old repo)

## Verify deployed

```bash
curl -s https://aura-backend.onrender.com/api/aura/status | jq .
curl -s https://aura-backend.onrender.com/api/health?aura=1 | jq .
```

Twilio voice webhook should point to:

- `https://<aura-backend-host>/api/aura/voice` or `/voice` (see `/api/aura/status` → `twilioWebhookUrl`)

## Note: backend696 also runs AURA

`https://ifcdc-barbers-backend696.onrender.com` already mounts the same AURA routes. Use **one** primary Twilio webhook URL. `aura-backend` is optional if you want voice/chat isolated on a separate Render service.
