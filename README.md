# QuickReply WhatsApp Gateway v6

Multi-tenant Baileys gateway. Auth state is stored in **Postgres (Neon)** so sessions
survive restarts. Supports both **QR-code** and **pairing-code** (8-digit) login.

## Deploy on Railway / Koyeb

1. Upload the project (or connect a repo).
2. Set env vars (see `.env.example`):
   - `DATABASE_URL` — your Neon Postgres URL with `sslmode=verify-full`
   - `GATEWAY_API_KEY` — same value as the Lovable secret
   - `WEBHOOK_SECRET` — same value as the Lovable secret
   - `WEBHOOK_URL` — `https://smart-biz-responder.lovable.app/api/wa/incoming`
3. Start command: `npm start` (auto from `package.json`).
4. Healthcheck path: `/health`.

## Endpoints (all require `x-api-key: $GATEWAY_API_KEY`)

- `POST /sessions/:userId/start` — start a session (QR mode by default)
- `POST /sessions/:userId/pair`  — body `{ "phoneNumber": "2348012345678" }`
   returns `{ "code": "ABCD-1234" }` to type on the phone
- `GET  /sessions/:userId/status` — `{ status, qr?, phone? }`
- `POST /sessions/:userId/send`  — body `{ "to": "234...", "text": "hello" }`
- `POST /sessions/:userId/logout`
