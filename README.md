# QuickReply WhatsApp Gateway

A standalone Baileys-powered WhatsApp Web gateway for the QuickReply SaaS app. Each user gets their own WhatsApp session, authenticated via QR code.

## What it does

- Exposes a REST API your Lovable app calls
- Manages multi-tenant WhatsApp Web sessions (one per user)
- Returns QR codes for users to scan with their phone
- Forwards incoming messages to your Lovable app's webhook (`/api/webhook`) with HMAC signature
- Auto-restores sessions on restart (auth files persisted to disk)

## Deploy to Railway (recommended, ~$5/month)

### 1. Push to GitHub
Create a new GitHub repo, then upload this entire folder to it.

### 2. Create Railway project
1. Go to https://railway.app → **New Project** → **Deploy from GitHub repo**
2. Select your repo
3. Railway auto-detects Node.js and runs `npm install` + `npm start`

### 3. Add a Volume (CRITICAL — sessions are lost on restart without this)
1. In your Railway service → **Settings** → **Volumes** → **+ New Volume**
2. Mount path: `/app/auth`
3. Size: 1 GB is plenty

### 4. Set environment variables
Go to **Variables** tab and add:

| Variable          | Value                                                           |
|-------------------|-----------------------------------------------------------------|
| `GATEWAY_API_KEY` | A long random string. Generate one: `openssl rand -hex 32`      |
| `WEBHOOK_URL`     | `https://smart-biz-responder.lovable.app/api/webhook`           |
| `WEBHOOK_SECRET`  | Another long random string (different from above)               |
| `AUTH_DIR`        | `/app/auth`                                                     |
| `PORT`            | `3000` (Railway sets this automatically, but safe to include)   |

### 5. Generate a public URL
**Settings** → **Networking** → **Generate Domain**. You'll get something like `quickreply-gateway-production.up.railway.app`.

### 6. Tell me three things
After deploy, give me:
1. Your gateway URL (e.g. `https://quickreply-gateway-production.up.railway.app`)
2. The `GATEWAY_API_KEY` value (I'll store it as a Lovable secret)
3. The `WEBHOOK_SECRET` value (I'll store it as a Lovable secret)

Then I'll wire the Lovable app to use the gateway.

## API Reference

All requests need `Authorization: Bearer <GATEWAY_API_KEY>`.

### `POST /session/:userId/start`
Boot a session for a user. Returns immediately. Poll `/status` for the QR code.

### `GET /session/:userId/status`
Returns `{ status, qr, error }` where status is one of:
- `idle` — no session, no saved auth
- `idle_has_session` — has saved auth but not running (call /start)
- `connecting` — booting up
- `qr` — QR available in `qr` field (data URL)
- `connected` — ready to send/receive
- `disconnected` / `logged_out`

### `POST /session/:userId/send`
Body: `{ "to": "2348012345678", "text": "Hello" }`. Phone number with country code, no `+`.

### `POST /session/:userId/logout`
Logs out and wipes auth files.

### Incoming webhook (sent to your Lovable app)
```json
POST {WEBHOOK_URL}
Headers: X-Gateway-Signature: <hmac_sha256_of_body>
Body: { "userId": "...", "from": "2348012345678", "text": "...", "messageId": "...", "timestamp": 123, "pushName": "..." }
```

Verify the signature in your webhook handler using `WEBHOOK_SECRET`.

## Local dev

```bash
npm install
GATEWAY_API_KEY=dev WEBHOOK_URL=http://localhost:3000/api/webhook WEBHOOK_SECRET=dev npm start
```

## ⚠️ Important notes

- **Unofficial library**: Baileys reverse-engineers WhatsApp Web. WhatsApp can ban numbers that misuse it (mass messaging, spam). Tell your users to use it for genuine business replies only.
- **Volume is mandatory** on Railway/any platform — without persistent storage, every restart kills all sessions.
- **One number per user** — each WhatsApp account can only be in one place at a time. If a user opens WhatsApp Web on their laptop, your session may disconnect.
