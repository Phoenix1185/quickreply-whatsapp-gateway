# QuickReply WhatsApp Gateway v2

Multi-tenant WhatsApp gateway using **Baileys** with **Supabase** session storage — **no persistent volume needed!**

## How it works

- Connects multiple users to WhatsApp via QR code
- Stores Baileys auth state in Supabase (table: `wa_auth_state`)
- Forwards incoming messages to your Lovable webhook (HMAC-signed)
- Sends auto-reply received from webhook back to WhatsApp

---

## Deploy to Railway (Free Trial)

1. Push this folder to a new GitHub repo.
2. railway.app → **New Project** → **Deploy from GitHub repo** → pick your repo.
3. Open **Variables** tab → add the env vars from `.env.example` (real values).
4. Open **Settings** → **Networking** → **Generate Domain**.
5. **Important:** Settings → toggle **Serverless OFF** (must stay always-on).
6. Done. Note the public URL (e.g. `https://your-app.up.railway.app`).

No volume needed — sessions live in Supabase.

---

## Deploy to Koyeb (Free Tier)

Koyeb has a generous free tier (1 web service, no card required for free).

1. Push this folder to GitHub.
2. koyeb.com → **Create Service** → **GitHub** → pick repo.
3. Builder: **Buildpack** (auto-detects Node).
4. Run command: `npm start`
5. Instance type: **Free (eco)**
6. Region: pick closest to you (e.g. `fra` Frankfurt).
7. **Environment variables**: paste all from `.env.example` with real values.
8. Port: `3000` (HTTP).
9. Deploy. Note the public URL (e.g. `https://your-app-org.koyeb.app`).

> Koyeb free instance sleeps after inactivity. For an always-on WhatsApp connection, upgrade to Starter ($2.7/mo) OR keep a cron pinging `/health` every 5 min.

---

## Required Env Vars

| Name | Value |
|---|---|
| `PORT` | `3000` |
| `GATEWAY_API_KEY` | Random 32+ char string (you generate) |
| `WEBHOOK_URL` | `https://smart-biz-responder.lovable.app/api/webhook` |
| `WEBHOOK_SECRET` | Random 32+ char string (must match Lovable secret) |
| `SUPABASE_URL` | `https://kiipfyrgqjqcmkizfxib.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | From Lovable Cloud → backend |

Generate random strings: `openssl rand -hex 32` or use https://generate-secret.vercel.app/32

---

## Endpoints

All require header `x-api-key: <GATEWAY_API_KEY>` except `/health`.

- `POST /session/:userId/start` — start connection (returns `{ok:true}`)
- `GET /session/:userId/status` — `{ status, qr, phone }` where status ∈ `connecting|qr|connected|disconnected|logged_out`
- `POST /session/:userId/send` body `{to, text}` — send a message
- `POST /session/:userId/logout` — disconnect & clear session
- `GET /health` — health check

---

## After deploying, give Lovable:

1. **Gateway URL** (e.g. `https://your-app.up.railway.app`)
2. **GATEWAY_API_KEY** value
3. **WEBHOOK_SECRET** value
